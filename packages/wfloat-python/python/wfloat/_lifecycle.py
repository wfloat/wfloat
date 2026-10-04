"""Synchronous registry asset lifecycle.

Transfers are shared within a process. Loaded models hold shared advisory locks;
mutations hold exclusive model locks and downloads also coordinate cache writes.
Independent processes can load cached models concurrently. Legacy cache writers
do not participate; use lifecycle-wrapped loaders. Inherited native instances
must not be used after fork; load fresh models in the child.
This module adds no browser persistence policy or inference initialization.
"""
from __future__ import annotations

import errno
import hashlib
import os
import re
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ._assets import WFLOAT_TTS_MODEL_ID
from ._cache import get_default_cache_dir, normalize_model_name
from ._download import extract_archive, resolve_extracted_data_directory
from ._generated_model_urls import MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS
from ._operations import OperationCancelledError, check_cancelled


class ModelAssetsDeletedError(RuntimeError):
    """A pending asset operation was invalidated by deletion."""


class ModelAssetsInUseError(RuntimeError):
    """An instance or another process owns assets needed by this operation."""


@dataclass(frozen=True)
class ModelProgressEvent:
    phase: Literal['checking', 'downloading', 'loading', 'ready']
    downloaded_bytes: Optional[int] = None
    total_bytes: Optional[int] = None
    progress: Optional[float] = None
    bytes_per_second: Optional[float] = None
    estimated_time_remaining_ms: Optional[float] = None


@dataclass(frozen=True)
class _Asset:
    url: str
    path: Path
    sha256: str
    size: Optional[int]
    shared: bool = False

    @property
    def partial(self):
        # Metadata is part of the checkpoint identity, so registry revisions
        # cannot accidentally append to a different immutable asset.
        identity = hashlib.sha256((self.url + self.sha256).encode()).hexdigest()[:20]
        return self.path.with_name(self.path.name + '.' + identity + '.part')


@dataclass
class _ModelState:
    epoch: int = 0
    deleting: bool = False
    leases: int = 0


@dataclass
class _Transfer:
    asset: _Asset
    ownership: object = None
    stop: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    users: int = 0
    position: int = 0  # durable file position, sampled under _guard
    received: int = 0  # network bytes only, never resumed bytes
    error: Optional[BaseException] = None


_guard = threading.RLock()
_states: dict[tuple[Path, str], _ModelState] = {}
_transfers: dict[Path, _Transfer] = {}
_install_locks: dict[Path, threading.Lock] = {}
_CHUNK = 128 * 1024
_TIMEOUT = 15


@dataclass
class _LockOwner:
    file: object
    shared: bool
    unlock: Callable
    references: int = 0


_file_owners: dict[Path, _LockOwner] = {}


def _windows_lock(file, shared):
    # msvcrt.LK_NBRLCK is NOT shared on Windows. Use the standard-library
    # ctypes binding to LockFileEx, which supports genuine shared byte locks.
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                    ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD),
                    ('hEvent', wintypes.HANDLE)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    lock = kernel.LockFileEx
    lock.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                     wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
    lock.restype = wintypes.BOOL
    unlock = kernel.UnlockFileEx
    unlock.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                       wintypes.DWORD, ctypes.POINTER(Overlapped)]
    unlock.restype = wintypes.BOOL
    handle = msvcrt.get_osfhandle(file.fileno())
    position = Overlapped()
    flags = 1 | (0 if shared else 2)  # FAIL_IMMEDIATELY | optional EXCLUSIVE
    if not lock(handle, flags, 0, 1, 0, ctypes.byref(position)):
        code = ctypes.get_last_error()
        if code in (32, 33):  # SHARING_VIOLATION / LOCK_VIOLATION
            raise BlockingIOError(errno.EAGAIN, 'Model asset lock is held')
        raise ctypes.WinError(code)

    def release():
        if not unlock(handle, 0, 1, 0, ctypes.byref(position)):
            raise ctypes.WinError(ctypes.get_last_error())
    return release


class _FileAccess:
    """Reference-count an OS lock of one mode; never upgrade a reader lock.

    Lock files are permanent and outside deletable model directories. Readers
    may share, writers may reenter within this process, but modes cannot mix.
    This avoids non-atomic upgrades/downgrades and native file-lifetime gaps.
    """
    def __init__(self, root, name, *, shared=False):
        self.path = root.resolve() / '.lifecycle-locks' / (name + '.lock')
        self.pid = os.getpid()
        self.released = False
        with _guard:
            owner = _file_owners.get(self.path)
            if owner is not None and owner.shared != shared:
                raise ModelAssetsInUseError('Model assets are in use by another local reader or writer')
            if owner is None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                lock_file = self.path.open('a+b')
                try:
                    if os.name == 'nt':
                        unlock = _windows_lock(lock_file, shared)
                    else:
                        import fcntl
                        mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
                        fcntl.flock(lock_file.fileno(), mode | fcntl.LOCK_NB)
                        unlock = lambda: fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                except BaseException as error:
                    lock_file.close()
                    if isinstance(error, OSError) and error.errno in (errno.EACCES, errno.EAGAIN, errno.EBUSY, errno.EDEADLK):
                        raise ModelAssetsInUseError(
                            'Another Python process is reading or changing these model assets; '
                            'retry after its operation finishes or unload the affected model.'
                        ) from error
                    raise  # No unsafe fallback on unsupported filesystems.
                owner = _LockOwner(lock_file, shared, unlock)
                _file_owners[self.path] = owner
            owner.references += 1

    def release(self):
        if self.pid != os.getpid():
            return
        with _guard:
            if self.released:
                return
            self.released = True
            owner = _file_owners[self.path]
            owner.references -= 1
            if owner.references == 0:
                try:
                    owner.unlock()
                finally:
                    owner.file.close()
                    del _file_owners[self.path]


def _model_lock_name(model_id):
    # Lock the physical directory identity, including normalized-name aliases.
    return 'model-' + hashlib.sha256(normalize_model_name(model_id).encode()).hexdigest()


@contextmanager
def _file_access(root, name, *, shared=False):
    access = _FileAccess(root, name, shared=shared)
    try:
        yield
    finally:
        access.release()


class _WriterAccess:
    """Workers retain both locks until they can no longer publish partials."""
    def __init__(self, root, model_id):
        self.cache = _FileAccess(root, 'mutation')
        try:
            self.model = _FileAccess(root, _model_lock_name(model_id))
        except BaseException:
            self.cache.release()
            raise

    def release(self):
        try:
            self.model.release()
        finally:
            self.cache.release()


@contextmanager
def _writer_access(root, model_id):
    access = _WriterAccess(root, model_id)
    try:
        yield
    finally:
        access.release()


def _after_fork():
    global _guard
    # Close inherited descriptors without LOCK_UN (flock open descriptions are
    # shared with the parent). Native models are not transferable across fork.
    for owner in _file_owners.values():
        owner.file.close()
    _file_owners.clear()
    _states.clear()
    _transfers.clear()
    _install_locks.clear()
    _guard = threading.RLock()


if hasattr(os, 'register_at_fork'):
    os.register_at_fork(after_in_child=_after_fork)


def _resolve(model_id, cache_dir):
    if not isinstance(model_id, str):
        raise TypeError('model_id must be a string')
    if model_id not in MODEL_ASSETS:
        raise ValueError(f'Unsupported model: {model_id}')
    root = (Path(cache_dir) if cache_dir is not None else get_default_cache_dir()).resolve()
    return root, (root, model_id)


def _assets(model_id, root):
    result = []
    entries = [(value, False) for value in MODEL_ASSETS[model_id].values()
               if isinstance(value, dict) and 'path' in value]
    if model_id == WFLOAT_TTS_MODEL_ID:
        entries.append((SHARED_ASSETS['espeak_ng_data_zip'], True))
    for entry, shared in entries:
        checksum = entry.get('sha256', '')
        size = entry.get('sizeBytes')
        path = entry['path']
        if not isinstance(checksum, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', checksum):
            raise ValueError('Registry asset must have a SHA-256 checksum')
        if size is not None and (type(size) is not int or size < 0):
            raise ValueError('Registry sizeBytes must be a nonnegative integer')
        if not isinstance(path, str) or not path.startswith('/') or Path(path).name in ('', '.', '..'):
            raise ValueError('Invalid registry asset path')
        destination = (root / 'shared' / checksum / Path(path).name if shared else
                       root / 'models' / normalize_model_name(model_id) / Path(path).name)
        result.append(_Asset(REGISTRY_ORIGIN + path, destination, checksum.lower(), size, shared))
    if len({a.path for a in result}) != len(result):
        raise ValueError('Registry assets have conflicting cache filenames')
    return result


def _valid(asset, path=None):
    path = path or asset.path
    if not path.is_file() or (asset.size is not None and path.stat().st_size != asset.size):
        return False
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(_CHUNK), b''):
            digest.update(chunk)
    return digest.hexdigest() == asset.sha256


def _assets_ready(model_id, root):
    for asset in _assets(model_id, root):
        if not _valid(asset):
            return False
        if asset.shared:
            installed = root / 'espeak' / asset.sha256
            if not (installed / '.ready').is_file() or not (installed / 'espeak-ng-data').is_dir():
                return False
    return True


def _remaining(asset):
    offset = asset.partial.stat().st_size if asset.partial.is_file() else 0
    if asset.size is None:
        return None
    if offset == asset.size and not _valid(asset, asset.partial):
        return asset.size
    return asset.size - offset if offset <= asset.size else asset.size


def _download(transfer):
    asset = transfer.asset
    partial = asset.partial
    try:
        asset.path.parent.mkdir(parents=True, exist_ok=True)
        if _valid(asset):
            return
        offset = partial.stat().st_size if partial.is_file() else 0
        if offset and asset.size is not None and offset >= asset.size:
            if _valid(asset, partial):
                check_cancelled(transfer.stop)
                os.replace(partial, asset.path)
                return
            partial.unlink()
            offset = 0
        headers = {'Accept-Encoding': 'identity', 'User-Agent': 'wfloat-python'}
        if offset:
            headers['Range'] = f'bytes={offset}-'
        try:
            response = urlopen(Request(asset.url, headers=headers), timeout=_TIMEOUT)
        except HTTPError as error:
            if error.code != 416 or not offset:
                raise
            error.close()
            # A stale checkpoint can outlive a server's range representation.
            partial.unlink(missing_ok=True)
            offset = 0
            headers.pop('Range', None)
            response = urlopen(Request(asset.url, headers=headers), timeout=_TIMEOUT)
        with response:
            status = getattr(response, 'status', None)
            if status == 206:
                content_range = response.headers.get('Content-Range', '')
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', content_range)
                if not match or int(match[1]) != offset or int(match[2]) < offset:
                    raise IOError('Invalid download Content-Range')
                if asset.size is not None and match[3] != str(asset.size):
                    raise IOError('Download range total differs from registry size')
            elif status in (200, None):
                offset = 0  # Server ignored Range: replace, never append.
            else:
                raise IOError(f'Unexpected download status: {status}')
            length = response.headers.get('Content-Length')
            if length is not None and asset.size is not None and int(length) != asset.size - offset:
                raise IOError('Download Content-Length differs from registry size')
            with partial.open('ab' if offset else 'wb') as target:
                while True:
                    check_cancelled(transfer.stop)
                    chunk = response.read(_CHUNK)
                    if not chunk:
                        break
                    if asset.size is not None and target.tell() + len(chunk) > asset.size:
                        raise IOError('Downloaded asset exceeds registry size')
                    with _guard:
                        target.write(chunk)
                        target.flush()
                        transfer.received += len(chunk)
                        transfer.position = target.tell()
                os.fsync(target.fileno())
        check_cancelled(transfer.stop)
        if not _valid(asset, partial):
            # Incomplete bytes may be reused; a full corrupt file must not be.
            if asset.size is None or partial.stat().st_size >= asset.size:
                partial.unlink(missing_ok=True)
            raise IOError('Downloaded asset failed size or SHA-256 verification')
        # Deletion sets stop under this same lock before waiting for completion.
        with _guard:
            check_cancelled(transfer.stop)
            os.replace(partial, asset.path)
    except BaseException as error:
        transfer.error = error
    finally:
        try:
            if transfer.ownership is not None:
                transfer.ownership.release()
        except BaseException as error:
            if transfer.error is None:
                transfer.error = error
        finally:
            transfer.done.set()


def _validate_options(on_progress, cancel_event):
    if on_progress is not None and not callable(on_progress):
        raise TypeError('on_progress must be callable')
    if cancel_event is not None and not isinstance(cancel_event, threading.Event):
        raise TypeError('cancel_event must be a threading.Event')


def _check(key, epoch, cancel_event):
    check_cancelled(cancel_event)
    with _guard:
        state = _states[key]
        if state.deleting or state.epoch != epoch:
            raise ModelAssetsDeletedError('Model assets were deleted during this operation')


def _begin(key):
    with _guard:
        state = _states.setdefault(key, _ModelState())
        if state.deleting:
            raise ModelAssetsDeletedError('Model asset deletion is in progress')
        return state.epoch


def _emit(callback, event):
    if callback is not None:
        callback(event)


def _install_shared(asset, root, check):
    destination = root / 'espeak' / asset.sha256
    with _guard:
        lock = _install_locks.setdefault(destination, threading.Lock())
    while not lock.acquire(timeout=0.02):
        check()
    try:
        check()
        if (destination / '.ready').is_file() and (destination / 'espeak-ng-data').is_dir():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.espeak-', dir=destination.parent) as temporary:
            stage = Path(temporary)
            extract_archive(asset.path, stage / 'extracted')
            source = resolve_extracted_data_directory(stage / 'extracted')
            install = stage / 'install'
            install.mkdir()
            shutil.copytree(source, install / 'espeak-ng-data')
            (install / '.ready').write_text('ready\n')
            check()
            if destination.exists():
                shutil.rmtree(destination)
            os.replace(install, destination)
    finally:
        lock.release()


def download_model(model_id: str, *, cache_dir: Optional[Path] = None,
                   on_progress: Optional[Callable[[ModelProgressEvent], None]] = None,
                   cancel_event: Optional[threading.Event] = None) -> None:
    """Save registry assets without loading inference; callbacks run inline.

    Cancellation withdraws only this caller. Transfers stop cooperatively when
    their last caller leaves, retaining checkpoints. Network reads have bounded
    timeouts. Registry metadata, not an HTTP cache hit, establishes local reuse.
    """
    _validate_options(on_progress, cancel_event)
    root, key = _resolve(model_id, cache_dir)
    check_cancelled(cancel_event)
    epoch = _begin(key)
    check = lambda: _check(key, epoch, cancel_event)
    _emit(on_progress, ModelProgressEvent('checking'))
    check()
    # Cached reads need only the model's shared lock, even when another process
    # is downloading an unrelated model under the short cache mutation lock.
    reader = None
    try:
        try:
            reader = _FileAccess(root, _model_lock_name(model_id), shared=True)
        except ModelAssetsInUseError:
            pass  # A same-process writer may be joined below.
        if reader is not None and _assets_ready(model_id, root):
            check()
            _emit(on_progress, ModelProgressEvent('ready'))
            check()
            return
    finally:
        if reader is not None:
            reader.release()
    with _writer_access(root, model_id):
        check()
        return _download_model(model_id, root, key, on_progress, cancel_event, epoch)


def _download_model(model_id, root, key, on_progress, cancel_event, epoch):
    check = lambda: _check(key, epoch, cancel_event)
    check()
    assets = _assets(model_id, root)
    subscriptions = []
    try:
        for asset in assets:
            check()
            if _valid(asset):
                continue
            while True:
                check()
                with _guard:
                    check()
                    transfer = _transfers.get(asset.path)
                    if transfer is None or transfer.done.is_set():
                        transfer = _Transfer(asset, ownership=_WriterAccess(root, model_id))
                        try:
                            remaining = _remaining(asset)
                            transfer.position = asset.size - remaining if asset.size is not None else 0
                            transfer.users = 1
                            _transfers[asset.path] = transfer
                            threading.Thread(target=_download, args=(transfer,), daemon=True).start()
                            subscriptions.append((transfer, 0, remaining))
                        except BaseException:
                            _transfers.pop(asset.path, None)
                            transfer.ownership.release()
                            raise
                        break
                    if not transfer.stop.is_set():
                        remaining = max(0, asset.size - transfer.position) if asset.size is not None else None
                        transfer.users += 1
                        subscriptions.append((transfer, transfer.received, remaining))
                        break
                transfer.done.wait(0.02)
        total = None if any(n is None for _, _, n in subscriptions) else sum(n for _, _, n in subscriptions)
        started = time.monotonic()
        previous_time, previous_bytes, speed = started, 0, None
        last = None
        while subscriptions:
            check()
            with _guard:
                received = sum(max(0, t.received - start) if n is None else min(n, max(0, t.received - start))
                               for t, start, n in subscriptions)
            now = time.monotonic()
            elapsed = now - previous_time
            if elapsed >= 0.1 and received > previous_bytes:
                sample = (received - previous_bytes) / elapsed
                speed = sample if speed is None else 0.25 * sample + 0.75 * speed
                previous_time, previous_bytes = now, received
            if received != last:
                _emit(on_progress, ModelProgressEvent(
                    'downloading', received, total,
                    received / total if total else None, speed,
                    (total - received) / speed * 1000 if total is not None and speed else None))
                last = received
            for transfer, _, _ in subscriptions:
                if transfer.done.is_set() and transfer.error is not None:
                    check()
                    raise transfer.error
            if all(t.done.is_set() for t, _, _ in subscriptions):
                break
            subscriptions[0][0].done.wait(0.02) if not subscriptions[0][0].done.is_set() else time.sleep(0.02)
        check()
        for asset in assets:
            if asset.shared:
                _install_shared(asset, root, check)
        check()
        _emit(on_progress, ModelProgressEvent('ready'))
        check()
    finally:
        with _guard:
            for transfer, _, _ in subscriptions:
                transfer.users -= 1
                if not transfer.users:
                    transfer.stop.set()
                    if transfer.done.is_set() and _transfers.get(transfer.asset.path) is transfer:
                        del _transfers[transfer.asset.path]


class AssetLease:
    """Protect files until native unload; release is idempotent.

    Loader owners must release on initialization failure and on unload. Leases
    deliberately prevent deletion rather than assume native engines copy files.
    """
    def __init__(self, key):
        self._ownership = _FileAccess(key[0], _model_lock_name(key[1]), shared=True)
        self._key = key
        self._released = False

    def release(self):
        if self._ownership.pid != os.getpid():
            return
        with _guard:
            if not self._released:
                _states[self._key].leases -= 1
                self._released = True
                self._ownership.release()


def acquire_model_asset_lease(model_id: str, *, cache_dir: Optional[Path] = None) -> AssetLease:
    _, key = _resolve(model_id, cache_dir)
    with _guard:
        _begin(key)
        lease = AssetLease(key)
        _states[key].leases += 1
        return lease


def load_with_lifecycle(model_id: str, initialize: Callable, *,
                        cache_dir: Optional[Path] = None, on_progress=None,
                        cancel_event: Optional[threading.Event] = None):
    """Loader integration hook: initialize(lease) returns an unloadable model.

    initialize must release the supplied lease after native unload, and must
    clean up any partially allocated native state if it raises. The old loader
    must use this cache_dir and force_download=False. This function never patches
    methods or infers native lifetime. It emits ready only after initialization.
    """
    _validate_options(on_progress, cancel_event)
    if not callable(initialize):
        raise TypeError('initialize must be callable')
    _, key = _resolve(model_id, cache_dir)
    check_cancelled(cancel_event)
    return _load_with_lifecycle(model_id, initialize, cache_dir, on_progress, cancel_event, key)


def _load_with_lifecycle(model_id, initialize, cache_dir, on_progress, cancel_event, key):
    epoch = _begin(key)
    lease = None
    model = None
    try:
        download_model(model_id, cache_dir=cache_dir, cancel_event=cancel_event,
                       on_progress=lambda event: _emit(on_progress, event) if event.phase != 'ready' else None)
        with _guard:
            _check(key, epoch, cancel_event)
            lease = acquire_model_asset_lease(model_id, cache_dir=cache_dir)
        # A different process may have deleted assets between the completed
        # download and shared lease acquisition. Do not let the legacy loader
        # silently redownload them while holding only a reader lock.
        if not _assets_ready(model_id, key[0]):
            raise ModelAssetsDeletedError('Model assets changed before initialization')
        _emit(on_progress, ModelProgressEvent('loading'))
        check_cancelled(cancel_event)
        model = initialize(lease)
        check_cancelled(cancel_event)
        _emit(on_progress, ModelProgressEvent('ready'))
        check_cancelled(cancel_event)
        return model
    except BaseException as original:
        try:
            if model is not None:
                model.unload()
        except BaseException:
            # Preserve the original error, but retain the lease: a failed native
            # unload is not evidence that deleting its files is now safe.
            if hasattr(original, 'add_note'):
                original.add_note('Native unload failed during load cleanup; asset lease retained.')
        else:
            if lease is not None:
                lease.release()
        raise


def delete_model_assets(model_id: str, *, cache_dir: Optional[Path] = None) -> None:
    """Delete model files and checkpoints, retaining shared dependencies.

    Raises ModelAssetsInUseError while a cooperating loaded instance holds a
    lease. Stops affected writers before returning. New requests may start once
    deletion completes. Readers/writers of this model in other processes cause a
    clear conflict; unrelated loaded models do not block deletion.
    Legacy writers that bypass the lifecycle are not coordinated.
    """
    root, key = _resolve(model_id, cache_dir)
    with _file_access(root, _model_lock_name(model_id)):
        return _delete_model_assets(model_id, root, key)


def _delete_model_assets(model_id, root, key):
    assets = _assets(model_id, root)
    with _guard:
        state = _states.setdefault(key, _ModelState())
        if state.leases:
            raise ModelAssetsInUseError('Unload models using these assets before deletion')
        if state.deleting:
            raise ModelAssetsDeletedError('Model asset deletion is already in progress')
        state.deleting = True
        state.epoch += 1
        affected = [t for a in assets if not a.shared
                    if (t := _transfers.get(a.path)) is not None]
        for transfer in affected:
            transfer.stop.set()
    try:
        for transfer in affected:
            transfer.done.wait()
        model_dir = root / 'models' / normalize_model_name(model_id)
        if model_dir.exists():
            shutil.rmtree(model_dir)
    finally:
        with _guard:
            state.deleting = False
            for transfer in affected:
                if _transfers.get(transfer.asset.path) is transfer:
                    del _transfers[transfer.asset.path]

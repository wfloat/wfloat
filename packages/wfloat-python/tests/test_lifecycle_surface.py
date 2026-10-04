"""Lifecycle integration checks using a bounded local registry server."""
import errno
import hashlib
import io
import json
import queue
import os
import types
import subprocess
import sys
import threading
import time
import tempfile
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from wfloat import _lifecycle as lifecycle
from wfloat._operations import OperationCancelledError


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.data = bytes(range(256)) * 4096
        self.requests = []
        self.payloads = {'/model.bin': self.data}
        self.ignore_range = False
        self.bad_range = False
        self.slow = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                data = owner.payloads[self.path]
                range_header = self.headers.get('Range')
                owner.requests.append((self.path, range_header))
                start = int(range_header[6:-1]) if range_header and not owner.ignore_range else 0
                self.send_response(206 if start else 200)
                self.send_header('Content-Length', str(len(data) - start))
                if start:
                    self.send_header('Content-Range', f'bytes {start + int(owner.bad_range)}-{len(data)-1}/{len(data)}')
                self.end_headers()
                try:
                    for position in range(start, len(data), 32768):
                        self.wfile.write(data[position:position + 32768])
                        self.wfile.flush()
                        if owner.slow:
                            time.sleep(0.004)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.model_id = 'test/model'
        self.metadata = {'family': 'test', 'model': self.asset('/model.bin')}
        self.patches = [patch.object(lifecycle, 'MODEL_ASSETS', {self.model_id: self.metadata}),
                        patch.object(lifecycle, 'REGISTRY_ORIGIN', f'http://127.0.0.1:{self.server.server_port}')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for transfer in list(lifecycle._transfers.values()):
            transfer.stop.set()
            self.assertTrue(transfer.done.wait(5))
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        for item in self.patches:
            item.stop()
        self.temporary.cleanup()

    def asset(self, path):
        data = self.payloads[path]
        return {'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'sizeBytes': len(data)}

    def download(self, **kwargs):
        return lifecycle.download_model(self.model_id, cache_dir=self.root, **kwargs)

    def test_download_atomic_integrity_cached_progress(self):
        events = []
        self.download(on_progress=events.append)
        destination = self.root / 'models/test--model/model.bin'
        self.assertEqual(destination.read_bytes(), self.data)
        self.assertEqual(events[0].phase, 'checking')
        self.assertEqual(events[-1].phase, 'ready')
        downloading = [e for e in events if e.phase == 'downloading']
        self.assertEqual(downloading[-1].progress, 1)
        events.clear()
        self.download(on_progress=events.append)
        self.assertEqual([e.phase for e in events], ['checking', 'ready'])
        self.assertEqual(len(self.requests), 1)

    def test_resume_remaining_denominator(self):
        asset = lifecycle._assets(self.model_id, self.root)[0]
        asset.partial.parent.mkdir(parents=True)
        asset.partial.write_bytes(self.data[:123456])
        events = []
        self.download(on_progress=events.append)
        self.assertEqual(self.requests[0][1], 'bytes=123456-')
        downloading = [e for e in events if e.phase == 'downloading']
        self.assertTrue(all(e.total_bytes == len(self.data) - 123456 for e in downloading))
        self.assertEqual(downloading[-1].downloaded_bytes, len(self.data) - 123456)
        self.assertEqual(asset.path.read_bytes(), self.data)

    def test_server_ignores_range_replaces_partial(self):
        self.ignore_range = True
        asset = lifecycle._assets(self.model_id, self.root)[0]
        asset.partial.parent.mkdir(parents=True)
        asset.partial.write_bytes(self.data[:123])
        self.download()
        self.assertEqual(asset.path.read_bytes(), self.data)

    def test_bad_range_never_publishes(self):
        self.bad_range = True
        asset = lifecycle._assets(self.model_id, self.root)[0]
        asset.partial.parent.mkdir(parents=True)
        asset.partial.write_bytes(self.data[:123])
        with self.assertRaisesRegex(IOError, 'Content-Range'):
            self.download()
        self.assertFalse(asset.path.exists())
        self.assertEqual(asset.partial.read_bytes(), self.data[:123])

    def test_integrity_failure_never_publishes(self):
        self.payloads['/model.bin'] = b'x' * len(self.data)
        with self.assertRaisesRegex(IOError, 'SHA-256'):
            self.download()
        asset = lifecycle._assets(self.model_id, self.root)[0]
        self.assertFalse(asset.path.exists())
        self.assertFalse(asset.partial.exists())

    def test_size_failure_never_publishes(self):
        self.metadata['model']['sizeBytes'] += 1
        with self.assertRaisesRegex(IOError, 'Content-Length'):
            self.download()
        self.assertFalse(lifecycle._assets(self.model_id, self.root)[0].path.exists())

    def test_unknown_total_is_indeterminate(self):
        self.metadata['model'].pop('sizeBytes')
        events = []
        self.download(on_progress=events.append)
        self.assertTrue(all(e.total_bytes is None and e.progress is None
                            for e in events if e.phase == 'downloading'))

    def test_cancel_preserves_partial_and_caller_event(self):
        self.slow = True
        cancel = threading.Event()
        def progress(event):
            if event.phase == 'downloading' and event.downloaded_bytes:
                cancel.set()
        with self.assertRaises(OperationCancelledError):
            self.download(cancel_event=cancel, on_progress=progress)
        self.assertTrue(cancel.is_set())
        for transfer in list(lifecycle._transfers.values()):
            self.assertTrue(transfer.done.wait(5))
        asset = lifecycle._assets(self.model_id, self.root)[0]
        self.assertTrue(asset.partial.exists())
        self.assertFalse(asset.path.exists())
        self.download()
        self.assertEqual(asset.path.read_bytes(), self.data)
        self.assertIsNotNone(self.requests[-1][1])

    def test_precancelled_and_invalid_options_do_no_io(self):
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(OperationCancelledError):
            self.download(cancel_event=cancel)
        with self.assertRaises(TypeError):
            self.download(cancel_event=object())
        with self.assertRaises(TypeError):
            self.download(on_progress=42)
        with self.assertRaises(TypeError):
            self.download(persistence='off')
        with self.assertRaises(ValueError):
            lifecycle.download_model('../bad', cache_dir=self.root)
        self.assertEqual(self.requests, [])

    def test_callback_errors_propagate_inline(self):
        error = LookupError('caller failure')
        caller = threading.get_ident()
        def callback(event):
            self.assertEqual(threading.get_ident(), caller)
            if event.phase == 'downloading':
                raise error
        with self.assertRaises(LookupError) as caught:
            self.download(on_progress=callback)
        self.assertIs(caught.exception, error)

    def test_shared_transfer_survives_one_caller_cancelling(self):
        self.slow = True
        joined = threading.Event()
        cancel = threading.Event()
        results = []
        def first_progress(event):
            if event.phase == 'downloading':
                joined.set()
        def first():
            try:
                self.download(on_progress=first_progress, cancel_event=cancel)
            except OperationCancelledError:
                results.append('cancelled')
        thread = threading.Thread(target=first)
        thread.start()
        self.assertTrue(joined.wait(5))
        events = []
        def second_progress(event):
            events.append(event)
            if event.phase == 'downloading':
                cancel.set()
        self.download(on_progress=second_progress)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, ['cancelled'])
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(events[-1].phase, 'ready')

    def test_delete_stops_writer_no_stale_publish(self):
        self.slow = True
        started = threading.Event()
        errors = []
        def download():
            try:
                self.download(on_progress=lambda event: started.set() if event.phase == 'downloading' else None)
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=download)
        thread.start()
        self.assertTrue(started.wait(5))
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], lifecycle.ModelAssetsDeletedError)
        self.assertFalse((self.root / 'models/test--model').exists())
        self.download()
        self.assertTrue((self.root / 'models/test--model/model.bin').is_file())

    def test_lease_refuses_delete_until_unload(self):
        lease = lifecycle.acquire_model_asset_lease(self.model_id, cache_dir=self.root)
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        lease.release()
        lease.release()
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)

    def test_load_progress_and_cleanup_at_cancel_boundary(self):
        cancel = threading.Event()
        events = []
        class Model:
            unloaded = False
            def unload(model):
                model.unloaded = True
                model.lease.release()
        model = Model()
        def initialize(lease):
            model.lease = lease
            cancel.set()
            return model
        with self.assertRaises(OperationCancelledError):
            lifecycle.load_with_lifecycle(self.model_id, initialize, cache_dir=self.root,
                                          cancel_event=cancel, on_progress=events.append)
        self.assertTrue(model.unloaded)
        self.assertEqual(events[-1].phase, 'loading')
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)

    def test_shared_espeak_installed_and_retained_on_delete(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zip_file:
            zip_file.writestr('espeak-ng-data/test', b'voice')
        self.payloads['/espeak.zip'] = archive.getvalue()
        shared = self.asset('/espeak.zip')
        with patch.object(lifecycle, 'WFLOAT_TTS_MODEL_ID', self.model_id), patch.object(
                lifecycle, 'SHARED_ASSETS', {'espeak_ng_data_zip': shared}):
            self.download()
            data = self.root / 'espeak' / shared['sha256'] / 'espeak-ng-data/test'
            self.assertEqual(data.read_bytes(), b'voice')
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
            self.assertTrue(data.exists())
            self.assertTrue((self.root / 'shared' / shared['sha256'] / 'espeak.zip').exists())

    def test_multiple_files_aggregate_progress(self):
        self.payloads['/tokens.txt'] = b'tokens'
        self.metadata['tokens'] = self.asset('/tokens.txt')
        events = []
        self.download(on_progress=events.append)
        downloading = [e for e in events if e.phase == 'downloading']
        self.assertTrue(all(e.total_bytes == len(self.data) + 6 for e in downloading))
        self.assertEqual(downloading[-1].downloaded_bytes, len(self.data) + 6)

    def test_existing_task_caches_reuse_downloads(self):
        from wfloat import _llm_assets, _stt_assets, _vad_assets
        self.download()
        asset = lifecycle._assets(self.model_id, self.root)[0]
        for module, name in [(_llm_assets, 'cache_llm_assets'),
                             (_stt_assets, 'cache_stt_assets'),
                             (_vad_assets, 'cache_vad_assets')]:
            with patch.object(module, 'download_file', side_effect=AssertionError('redownload')):
                cached = getattr(module, name)(
                    self.model_id, family='test', sources={'model': asset.url},
                    checksums={'model': asset.sha256}, cache_dir=self.root)
            self.assertEqual(cached.require('model').read_bytes(), self.data)

    def test_existing_tts_cache_reuses_downloads_and_espeak(self):
        from wfloat import _cache
        from wfloat._assets import ModelAssets
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zip_file:
            zip_file.writestr('espeak-ng-data/test', b'voice')
        self.payloads['/espeak.zip'] = archive.getvalue()
        self.payloads['/tokens.txt'] = b'tokens'
        self.metadata['tokens'] = self.asset('/tokens.txt')
        shared = self.asset('/espeak.zip')
        with patch.object(lifecycle, 'WFLOAT_TTS_MODEL_ID', self.model_id), patch.object(
                lifecycle, 'SHARED_ASSETS', {'espeak_ng_data_zip': shared}):
            self.download()
            model, tokens, espeak = lifecycle._assets(self.model_id, self.root)
        assets = ModelAssets(model.url, model.sha256, tokens.url, tokens.sha256,
                             espeak.url, espeak.sha256)
        with patch.object(_cache, 'download_file', side_effect=AssertionError('redownload')):
            cached = _cache.cache_model_assets(self.model_id, assets, cache_dir=self.root)
        self.assertEqual(cached.model_path.read_bytes(), self.data)
        self.assertEqual((cached.espeak_data_dir / 'test').read_bytes(), b'voice')

    def test_successful_load_ready_callback_and_unload_lease(self):
        events = []
        class Model:
            def __init__(model, lease):
                model.lease = lease
            def unload(model):
                model.lease.release()
        model = lifecycle.load_with_lifecycle(self.model_id, Model, cache_dir=self.root,
                                              on_progress=events.append)
        self.assertEqual([event.phase for event in events][-2:], ['loading', 'ready'])
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        model.unload()
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)

    def test_ready_callback_failure_unloads_and_preserves_exception(self):
        unloaded = []
        error = LookupError('callback')
        class Model:
            def __init__(model, lease):
                model.lease = lease
            def unload(model):
                unloaded.append(True)
                model.lease.release()
        def progress(event):
            if event.phase == 'ready':
                raise error
        with self.assertRaises(LookupError) as caught:
            lifecycle.load_with_lifecycle(self.model_id, Model, cache_dir=self.root,
                                          on_progress=progress)
        self.assertIs(caught.exception, error)
        self.assertEqual(unloaded, [True])
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)

    def test_storage_failure_has_no_fallback(self):
        (self.root / 'models').write_text('not a directory')
        with self.assertRaises(OSError):
            self.download()
        self.assertEqual(self.requests, [])

    def test_corrupt_complete_checkpoint_is_replaced(self):
        asset = lifecycle._assets(self.model_id, self.root)[0]
        asset.partial.parent.mkdir(parents=True)
        asset.partial.write_bytes(b'x' * len(self.data))
        events = []
        self.download(on_progress=events.append)
        self.assertEqual(asset.path.read_bytes(), self.data)
        downloading = [event for event in events if event.phase == 'downloading']
        self.assertEqual(downloading[-1].total_bytes, len(self.data))
        self.assertEqual(downloading[-1].progress, 1)

    def test_failed_native_cleanup_keeps_files_protected(self):
        error = LookupError('callback')
        leases = []
        class Model:
            def __init__(model, lease):
                leases.append(lease)
            def unload(model):
                raise RuntimeError('native cleanup failed')
        def progress(event):
            if event.phase == 'ready':
                raise error
        with self.assertRaises(LookupError) as caught:
            lifecycle.load_with_lifecycle(self.model_id, Model, cache_dir=self.root,
                                          on_progress=progress)
        self.assertIs(caught.exception, error)
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        leases[0].release()

    def test_delete_invalidates_pending_load_before_initialization(self):
        self.slow = True
        started = threading.Event()
        initialized = []
        errors = []
        def load():
            try:
                lifecycle.load_with_lifecycle(
                    self.model_id, lambda lease: initialized.append(lease), cache_dir=self.root,
                    on_progress=lambda event: started.set() if event.phase == 'downloading' else None)
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=load)
        thread.start()
        self.assertTrue(started.wait(5))
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(initialized, [])
        self.assertIsInstance(errors[0], lifecycle.ModelAssetsDeletedError)

    def child(self, mode, *, model_id=None, metadata=None):
        script = r"""
import json, sys
from pathlib import Path
from wfloat import _lifecycle as lifecycle
root, model_id, metadata, origin, mode = json.loads(sys.argv[1])
lifecycle.MODEL_ASSETS = {model_id: metadata}
lifecycle.REGISTRY_ORIGIN = origin
try:
    if mode == 'lease':
        lease = lifecycle.acquire_model_asset_lease(model_id, cache_dir=Path(root))
        print('locked', flush=True)
        sys.stdin.readline()
        lease.release()
    elif mode == 'download':
        with lifecycle._writer_access(Path(root), model_id):
            print('locked', flush=True)
            sys.stdin.readline()
            lifecycle.download_model(model_id, cache_dir=Path(root))
    elif mode == 'loaded':
        # Exercise the public loader and real legacy cache, substituting only
        # native initialization with a backend that holds a real mmap open.
        import mmap
        import wfloat
        from wfloat import _language_load
        from wfloat._assets import LlmModelAssets
        class Backend:
            def __init__(self, path, *, context_size, **kwargs):
                self.context_size = context_size
                self.file = path.open('rb')
                self.mapping = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
            def unload(self):
                self.mapping.close()
                self.file.close()
        _language_load.NativeLanguageBackend = Backend
        _language_load.fetch_llm_assets = lambda _: LlmModelAssets(
            'test', origin + metadata['model']['path'], metadata['model']['sha256'])
        model = wfloat.load_language_model(model_id, cache_dir=Path(root))
        print('locked', flush=True)
        sys.stdin.readline()
        model.unload()
    elif mode == 'delete':
        lifecycle.delete_model_assets(model_id, cache_dir=Path(root))
        print('deleted', flush=True)
except lifecycle.ModelAssetsInUseError:
    print('busy', flush=True)
"""
        arguments = json.dumps([str(self.root), model_id or self.model_id, metadata or self.metadata,
                                lifecycle.REGISTRY_ORIGIN, mode])
        process = subprocess.Popen([sys.executable, '-u', '-c', script, arguments],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        output = queue.Queue()
        threading.Thread(target=lambda: output.put(process.stdout.readline()), daemon=True).start()
        try:
            line = output.get(timeout=10).strip()
        except queue.Empty:
            self.fail('Child did not report lock state')
        if not line:
            self.fail('Child failed: ' + process.stderr.read())
        return process, line

    def test_process_lease_blocks_delete_but_allows_cached_download(self):
        self.download()
        destination = self.root / 'models/test--model/model.bin'
        process, state = self.child('lease')
        self.assertEqual(state, 'locked')
        with self.assertRaisesRegex(lifecycle.ModelAssetsInUseError, 'Another Python process'):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        self.download()
        self.assertEqual(destination.read_bytes(), self.data)
        self.assertEqual(len(self.requests), 1)
        process.communicate('release\n', timeout=5)
        self.assertEqual(process.returncode, 0)
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        self.assertFalse(destination.exists())
        self.assertTrue((self.root / '.lifecycle-locks').is_dir())

    def test_process_download_conflict_does_not_touch_partial(self):
        asset = lifecycle._assets(self.model_id, self.root)[0]
        asset.partial.parent.mkdir(parents=True)
        asset.partial.write_bytes(self.data[:12345])
        process, state = self.child('download')
        self.assertEqual(state, 'locked')
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            self.download()
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        self.assertEqual(asset.partial.read_bytes(), self.data[:12345])
        self.assertEqual(self.requests, [])
        _, error = process.communicate('release\n', timeout=10)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(asset.path.read_bytes(), self.data)
        self.assertEqual(self.requests, [('/model.bin', 'bytes=12345-')])

    def test_crashed_process_releases_os_lock(self):
        process, state = self.child('lease')
        self.assertEqual(state, 'locked')
        process.kill()
        process.wait(timeout=5)
        self.download()
        self.assertEqual(len(self.requests), 1)

    def test_local_model_lease_blocks_child_until_last_release(self):
        first = lifecycle.acquire_model_asset_lease(self.model_id, cache_dir=self.root)
        second = lifecycle.acquire_model_asset_lease(self.model_id, cache_dir=self.root)
        try:
            first.release()
            process, state = self.child('delete')
            self.assertEqual(state, 'busy')
            process.wait(timeout=5)
        finally:
            first.release()
            second.release()
        process, state = self.child('lease')
        self.assertEqual(state, 'locked')
        process.communicate('release\n', timeout=5)

    def test_cancelled_worker_keeps_process_lock_until_stopped(self):
        entered = threading.Event()
        unblock = threading.Event()
        cancel = threading.Event()
        def blocked_open(*args, **kwargs):
            entered.set()
            unblock.wait(5)
            raise OSError('stopped test connection')
        def progress(event):
            if event.phase == 'downloading':
                self.assertTrue(entered.wait(5))
                cancel.set()
        try:
            with patch.object(lifecycle, 'urlopen', side_effect=blocked_open):
                with self.assertRaises(OperationCancelledError):
                    self.download(cancel_event=cancel, on_progress=progress)
                process, state = self.child('lease')
                self.assertEqual(state, 'busy')
                process.wait(timeout=5)
        finally:
            unblock.set()
        for transfer in list(lifecycle._transfers.values()):
            self.assertTrue(transfer.done.wait(5))
        process, state = self.child('lease')
        self.assertEqual(state, 'locked')
        process.communicate('release\n', timeout=5)

    @unittest.skipIf(os.name == 'nt', 'POSIX lock failure injection')
    def test_unsupported_file_lock_fails_without_download(self):
        with patch('fcntl.flock', side_effect=OSError(errno.EOPNOTSUPP, 'unsupported lock')):
            with self.assertRaises(OSError):
                self.download()
        self.assertEqual(self.requests, [])
        self.assertFalse(any(path.parent.parent == self.root for path in lifecycle._file_owners))
        self.download()

    def test_windows_adapter_requests_real_shared_and_exclusive_locks(self):
        import ctypes
        calls = []
        class Function:
            def __init__(self, name):
                self.name = name
            def __call__(self, *args):
                calls.append((self.name, args[:-1]))
                return 1
        kernel = types.SimpleNamespace(LockFileEx=Function('lock'), UnlockFileEx=Function('unlock'))
        fake_msvcrt = types.SimpleNamespace(get_osfhandle=lambda fd: fd)
        with patch.object(ctypes, 'WinDLL', return_value=kernel, create=True), patch.dict(
                sys.modules, {'msvcrt': fake_msvcrt}):
            with (self.root / 'adapter.lock').open('a+b') as file:
                lifecycle._windows_lock(file, True)()
                lifecycle._windows_lock(file, False)()
        self.assertEqual([name for name, _ in calls], ['lock', 'unlock', 'lock', 'unlock'])
        self.assertEqual(calls[0][1][1:], (1, 0, 1, 0))
        self.assertEqual(calls[2][1][1:], (3, 0, 1, 0))

    def test_multiple_processes_load_same_cached_model_concurrently(self):
        self.download()
        first, state = self.child('loaded')
        self.assertEqual(state, 'locked')
        second, state = self.child('loaded')
        self.assertEqual(state, 'locked')
        self.download()
        self.assertEqual(len(self.requests), 1)
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        first.communicate('release\n', timeout=5)
        with self.assertRaises(lifecycle.ModelAssetsInUseError):
            lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        second.communicate('release\n', timeout=5)
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)

    def test_unrelated_transfer_allows_cached_reader_process(self):
        self.download()
        other, state = self.child('download', model_id='other/model')
        self.assertEqual(state, 'locked')
        reader, state = self.child('loaded')
        self.assertEqual(state, 'locked')
        self.download()
        reader.communicate('release\n', timeout=5)
        # Deleting this model doesn't need the unrelated cache mutation lock.
        lifecycle.delete_model_assets(self.model_id, cache_dir=self.root)
        other.communicate('release\n', timeout=10)
        self.assertEqual(other.returncode, 0)

    def test_loaded_model_does_not_block_unrelated_model_download(self):
        self.download()
        loaded, state = self.child('loaded')
        self.assertEqual(state, 'locked')
        other, state = self.child('download', model_id='other/model')
        self.assertEqual(state, 'locked')
        other.communicate('release\n', timeout=10)
        self.assertEqual(other.returncode, 0)
        loaded.communicate('release\n', timeout=5)


if __name__ == '__main__':
    unittest.main()

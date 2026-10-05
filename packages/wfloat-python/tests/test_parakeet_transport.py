"""Small transport fixtures only: no model download or native inference."""
import hashlib
import io
import threading
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

import wfloat
from wfloat import _assets, _lifecycle as lifecycle
from wfloat._assets import PARAKEET_TDT_MODEL_ID as MODEL
from wfloat._operations import OperationCancelledError
from wfloat._stt_assets import cache_stt_model_assets


@pytest.fixture
def registry(monkeypatch, tmp_path):
    payloads = {'/test/encoder.part1': b'abcd' * 10000, '/test/encoder.part2': b'efgh' * 10000,
                '/test/decoder.onnx': b'decoder', '/test/joiner.onnx': b'joiner', '/test/tokens.txt': b'tokens'}
    def record(path):
        data = payloads[path]
        return dict(path=path, sha256=hashlib.sha256(data).hexdigest(), sizeBytes=len(data))
    whole = payloads['/test/encoder.part1'] + payloads['/test/encoder.part2']
    data = dict(family='parakeet-tdt', encoder=dict(
        parts=[record('/test/encoder.part1'), record('/test/encoder.part2')],
        sha256=hashlib.sha256(whole).hexdigest(), sizeBytes=len(whole), filename='encoder.int8.onnx'),
        decoder=record('/test/decoder.onnx'), joiner=record('/test/joiner.onnx'), tokens=record('/test/tokens.txt'))
    monkeypatch.setattr(_assets, 'MODEL_ASSETS', {MODEL: data})
    monkeypatch.setattr(lifecycle, 'MODEL_ASSETS', {MODEL: data})
    calls = []
    def open_asset(request, **kwargs):
        path = request.full_url.removeprefix(_assets.REGISTRY_ORIGIN)
        calls.append(path)
        content = payloads[path]
        response = io.BytesIO(content)
        response.status, response.headers = 200, {'Content-Length': str(len(content))}
        return response
    monkeypatch.setattr(lifecycle, 'urlopen', open_asset)
    fixture = SimpleNamespace(data=data, payloads=payloads, whole=whole, calls=calls,
                              root=tmp_path, directory=tmp_path / 'models' / MODEL.replace('/', '--'))
    yield fixture
    for transfer in list(lifecycle._transfers.values()):
        if transfer.asset.path.is_relative_to(tmp_path):
            transfer.stop.set()
            assert transfer.done.wait(5)


def test_assembly_reuse_repair_and_delete(registry):
    r = registry
    events = []
    wfloat.download_model(MODEL, cache_dir=r.root, on_progress=events.append)
    encoder = r.directory / 'encoder.int8.onnx'
    assert encoder.read_bytes() == r.whole
    assert len(r.calls) == 5
    network = [event for event in events if event.phase == 'downloading']
    assert network[-1].downloaded_bytes == sum(map(len, r.payloads.values()))
    assert network[-1].total_bytes == sum(map(len, r.payloads.values()))
    assets = _assets.fetch_stt_assets(MODEL)
    assert assets.encoder is None and assets.encoder_filename == encoder.name
    with patch('wfloat._stt_assets.download_file', side_effect=AssertionError('legacy network')):
        cached = cache_stt_model_assets(MODEL, assets, cache_dir=r.root)
    assert cached.require('encoder') == encoder
    wfloat.download_model(MODEL, cache_dir=r.root)
    assert len(r.calls) == 5
    encoder.write_bytes(b'corrupt assembled file')
    events.clear()
    wfloat.download_model(MODEL, cache_dir=r.root, on_progress=events.append)
    assert [event.phase for event in events] == ['checking', 'ready']
    assert encoder.read_bytes() == r.whole and len(r.calls) == 5
    (r.directory / 'encoder.part2').unlink()
    events.clear()
    wfloat.download_model(MODEL, cache_dir=r.root, on_progress=events.append)
    network = [event for event in events if event.phase == 'downloading']
    assert network[-1].total_bytes == network[-1].downloaded_bytes == len(r.payloads['/test/encoder.part2'])
    assert r.calls[-1] == '/test/encoder.part2' and len(r.calls) == 6
    (r.directory / 'encoder.part1').write_bytes(b'x' * 40000)
    wfloat.download_model(MODEL, cache_dir=r.root)
    assert r.calls[-1] == '/test/encoder.part1' and len(r.calls) == 7
    wfloat.delete_model_assets(MODEL, cache_dir=r.root)
    assert not r.directory.exists()


@pytest.mark.parametrize('failure', ['missing', 'corrupt', 'whole'])
def test_failed_integrity_never_promotes_or_initializes(registry, failure):
    r = registry
    if failure == 'missing':
        del r.payloads['/test/encoder.part2']
    elif failure == 'corrupt':
        r.payloads['/test/encoder.part2'] = b'x' * 40000
    else:
        r.data['encoder']['sha256'] = '0' * 64
    with patch('wfloat._stt_load.create_core_stt') as native:
        with pytest.raises((KeyError, IOError)):
            wfloat.load_speech_to_text(MODEL, cache_dir=r.root)
        native.assert_not_called()
    assert not (r.directory / 'encoder.int8.onnx').exists()
    wfloat.delete_model_assets(MODEL, cache_dir=r.root)
    assert not r.directory.exists()


@pytest.mark.parametrize('fault', ['empty', 'missing-part', 'checksum', 'size', 'filename', 'collision', 'path'])
def test_invalid_composite_rejected_before_network(registry, fault):
    entry = registry.data['encoder']
    if fault == 'empty':
        entry['parts'] = []
    elif fault == 'missing-part':
        entry['parts'].pop()
    elif fault == 'checksum':
        del entry['parts'][0]['sha256']
    elif fault == 'size':
        entry['sizeBytes'] += 1
    elif fault == 'filename':
        entry['filename'] = '../encoder.onnx'
    elif fault == 'collision':
        entry['filename'] = 'decoder.onnx'
    else:
        entry['path'] = '/fake/publicURL'
    with pytest.raises(ValueError):
        wfloat.download_model(MODEL, cache_dir=registry.root)
    assert not registry.calls


@pytest.mark.parametrize('load', [wfloat.load_speech_to_text, wfloat.load_streaming_speech_to_text])
def test_public_load_uses_reconstructed_encoder_and_keeps_lease(registry, load):
    r = registry
    native = SimpleNamespace(sample_rate=16000, close=lambda: None,
                             transcribe_result=lambda **kw: SimpleNamespace(text='bonjour', segments=None))
    with patch('wfloat._stt_load.create_core_stt', return_value=native) as create, \
            patch('wfloat._stt_assets.download_file', side_effect=AssertionError('legacy network')):
        for _ in range(2):
            model = load(MODEL, cache_dir=r.root)
            assert create.call_args.kwargs['encoder_path'].read_bytes() == r.whole
            assert create.call_args.kwargs['family'] == 'parakeet-tdt'
            assert create.call_args.kwargs['language'] is None
            assert not create.call_args.kwargs['enable_token_timestamps']
            assert not create.call_args.kwargs['enable_segment_timestamps']
            audio = np.ones(160, np.float32)
            assert model.transcribe(audio, sample_rate=16000).text == 'bonjour'
            for options in [dict(language='en'), dict(language='fr'), dict(hotwords=['hello']),
                            dict(timestamps='word'), dict(timestamps='segment')]:
                with pytest.raises(ValueError):
                    model.transcribe(audio, sample_rate=16000, **options)
            with pytest.raises(wfloat.ModelAssetsInUseError):
                wfloat.delete_model_assets(MODEL, cache_dir=r.root)
            model.unload()
        assert len(r.calls) == 5
    wfloat.delete_model_assets(MODEL, cache_dir=r.root)


@pytest.mark.parametrize('action', ['cancel', 'delete'])
def test_stop_during_assembly_never_promotes(registry, monkeypatch, action):
    r = registry
    wfloat.download_model(MODEL, cache_dir=r.root)
    encoder = r.directory / 'encoder.int8.onnx'
    encoder.unlink()
    entered, release = threading.Event(), threading.Event()
    original = lifecycle._assemble
    def paused(transfer):
        entered.set()
        assert release.wait(5)
        original(transfer)
    monkeypatch.setattr(lifecycle, '_assemble', paused)
    cancel = threading.Event()
    errors = []
    def run():
        try:
            wfloat.download_model(MODEL, cache_dir=r.root, cancel_event=cancel)
        except BaseException as error:
            errors.append(error)
    caller = threading.Thread(target=run)
    caller.start()
    assert entered.wait(5)
    if action == 'cancel':
        cancel.set()
        caller.join(5)
        assert not caller.is_alive()
        release.set()
        wfloat.delete_model_assets(MODEL, cache_dir=r.root)
    else:
        deleted = threading.Event()
        def delete():
            wfloat.delete_model_assets(MODEL, cache_dir=r.root)
            deleted.set()
        deleter = threading.Thread(target=delete)
        deleter.start()
        caller.join(5)
        assert not caller.is_alive() and not deleted.is_set()
        release.set()
        deleter.join(5)
        assert deleted.is_set()
    assert isinstance(errors[0], OperationCancelledError if action == 'cancel' else lifecycle.ModelAssetsDeletedError)
    assert not r.directory.exists()
    wfloat.download_model(MODEL, cache_dir=r.root)
    assert encoder.read_bytes() == r.whole


def test_cancellation_mid_copy_discards_partial_but_reuses_parts(registry, monkeypatch):
    r = registry
    wfloat.download_model(MODEL, cache_dir=r.root)
    encoder = r.directory / 'encoder.int8.onnx'
    encoder.unlink()
    entered, release = threading.Event(), threading.Event()
    original = lifecycle.check_cancelled
    original_open = Path.open
    def unbuffered_assembly(path, mode='r', *args, **kwargs):
        if mode == 'wb' and path.name.startswith('encoder.int8.onnx.'):
            kwargs['buffering'] = 0
        return original_open(path, mode, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', unbuffered_assembly)
    def pause_after_write(event):
        if event is not cancel and threading.current_thread() is not threading.main_thread():
            partials = list(r.directory.glob('encoder.int8.onnx.*.part'))
            if partials and partials[0].stat().st_size:
                entered.set()
                assert release.wait(5)
        original(event)
    monkeypatch.setattr(lifecycle, 'check_cancelled', pause_after_write)
    monkeypatch.setattr(lifecycle, '_CHUNK', 1024)
    cancel, errors = threading.Event(), []
    def run():
        try:
            wfloat.download_model(MODEL, cache_dir=r.root, cancel_event=cancel)
        except BaseException as error:
            errors.append(error)
    caller = threading.Thread(target=run)
    caller.start()
    assert entered.wait(5)
    cancel.set()
    caller.join(5)
    release.set()
    assert not caller.is_alive() and isinstance(errors[0], OperationCancelledError)
    for transfer in list(lifecycle._transfers.values()):
        if transfer.asset.path == encoder:
            assert transfer.done.wait(5)
    assert not encoder.exists() and not list(r.directory.glob('encoder.int8.onnx.*.part'))
    wfloat.download_model(MODEL, cache_dir=r.root)
    assert len(r.calls) == 5 and encoder.read_bytes() == r.whole


def test_legacy_loader_requires_ready_composite_without_network(registry):
    with patch('wfloat._stt_assets.download_file') as network:
        with pytest.raises(RuntimeError, match='download_model'):
            wfloat.load_stt_model(MODEL, cache_dir=registry.root)
        network.assert_not_called()


def test_one_cancelled_caller_does_not_stop_shared_assembly(registry, monkeypatch):
    r = registry
    wfloat.download_model(MODEL, cache_dir=r.root)
    encoder = r.directory / 'encoder.int8.onnx'
    encoder.unlink()
    entered, release, joined = threading.Event(), threading.Event(), threading.Event()
    original = lifecycle._assemble
    def paused(transfer):
        entered.set()
        assert release.wait(5)
        original(transfer)
    monkeypatch.setattr(lifecycle, '_assemble', paused)
    cancel, errors = threading.Event(), []
    def run(event=None, progress=None):
        try:
            wfloat.download_model(MODEL, cache_dir=r.root, cancel_event=event, on_progress=progress)
        except BaseException as error:
            errors.append(error)
    first = threading.Thread(target=run, args=(cancel,))
    first.start()
    assert entered.wait(5)
    original_check = lifecycle._check
    def check_joined(*args):
        original_check(*args)
        with lifecycle._guard:
            transfer = lifecycle._transfers.get(encoder)
            if transfer is not None and transfer.users == 2:
                joined.set()
    monkeypatch.setattr(lifecycle, '_check', check_joined)
    second = threading.Thread(target=run)
    second.start()
    assert joined.wait(5)
    cancel.set()
    first.join(5)
    assert not first.is_alive()
    release.set()
    second.join(5)
    assert not second.is_alive()
    assert len(errors) == 1 and isinstance(errors[0], OperationCancelledError)
    assert encoder.read_bytes() == r.whole and len(r.calls) == 5

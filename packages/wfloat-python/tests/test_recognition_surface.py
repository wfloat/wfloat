import threading
from types import SimpleNamespace

import numpy as np
import pytest

from wfloat._audio import Audio
from wfloat._recognition import (SpeechToTextModel, StreamingSpeechToTextModel,
    TranscriptionError, _overlap)


class Decoder:
    sample_rate = 16000
    def __init__(self, texts=None):
        self.calls = []
        self.texts = iter(texts) if texts else None
        self.closed = False
        self.hook = None
    def transcribe_result(self, *, samples, **kwargs):
        self.calls.append(samples.copy())
        if self.hook:
            self.hook()
        text = next(self.texts) if self.texts else f'part{len(self.calls)}'
        return SimpleNamespace(text=text, segments=None)
    def close(self):
        self.closed = True


def pcm(seconds):
    return Audio(np.full(round(seconds * 16000), .1, np.float32), 16000)


def test_file_windows_cover_every_sample_and_preview_is_whole_text():
    native = Decoder()
    model = SpeechToTextModel('fake', native)
    updates = []
    audio = pcm(61)
    result = model.transcribe(audio, on_transcript=updates.append)
    assert [len(x) for x in native.calls] == [400000, 400000, 176000]
    np.testing.assert_array_equal(np.concatenate(native.calls), audio.samples)
    assert result.text == 'part1 part2 part3'
    assert [x.text for x in updates] == ['part1', 'part1 part2', result.text]


def test_live_decodes_inline_and_drains_long_push_without_truncation():
    native = Decoder()
    model = StreamingSpeechToTextModel('fake', native)
    updates = []
    session = model.create_session(on_transcript=updates.append)
    session.push(pcm(61))
    assert updates and not any(x.is_final for x in updates)
    assert max(map(len, native.calls)) <= 25 * 16000
    assert len(session._audio) <= 25 * 16000
    result = session.finish()
    assert result.stop_reason == 'complete'
    assert updates[-1].is_final and updates[-1].id == result.segments[0].id == '0'
    assert session._position + session._decoded >= 61 * 16000
    assert session.finish() is result
    assert session.result() is result


def test_cancel_keeps_provisional_separate_and_model_reusable():
    model = StreamingSpeechToTextModel('fake', Decoder())
    session = model.create_session()
    session.push(pcm(4))
    session.cancel()
    result = session.result()
    assert result.text == '' and result.provisional.text == 'part1'
    assert result.stop_reason == 'cancelled'
    model.create_session().cancel()


def test_file_cancel_in_native_call_does_not_finalize_guess():
    native = Decoder()
    stop = threading.Event()
    native.hook = stop.set
    result = SpeechToTextModel('fake', native).transcribe(pcm(30), cancel_event=stop)
    assert result.text == '' and result.provisional.text == 'part1'
    assert len(native.calls) == 1 and stop.is_set()


def test_callback_failure_identity_and_session_cleanup():
    original = RuntimeError('application callback')
    model = StreamingSpeechToTextModel('fake', Decoder())
    def fail(_):
        raise original
    session = model.create_session(on_transcript=fail)
    with pytest.raises(RuntimeError) as caught:
        session.push(pcm(4))
    assert caught.value is original
    with pytest.raises(RuntimeError) as caught:
        session.result()
    assert caught.value is original
    model.create_session().cancel()


def test_native_failure_has_partial_and_same_error_notification():
    native = Decoder()
    model = StreamingSpeechToTextModel('fake', native)
    errors = []
    session = model.create_session(on_error=errors.append)
    session.push(pcm(4))
    original = RuntimeError('native broke')
    def fail():
        raise original
    native.hook = fail
    with pytest.raises(TranscriptionError) as caught:
        session.push(pcm(2))
    assert caught.value.__cause__ is original
    assert caught.value.partial_result.provisional.text == 'part1'
    assert errors == [caught.value]
    with pytest.raises(TranscriptionError) as again:
        session.finish()
    assert again.value is caught.value


def test_invalid_input_does_not_destroy_live_session():
    model = StreamingSpeechToTextModel('fake', Decoder())
    session = model.create_session()
    with pytest.raises(ValueError):
        session.push(np.zeros(3))
    session.push(pcm(1))
    assert session.finish().stop_reason == 'complete'


def test_reentrant_file_work_rejects_and_unload_cancels_session():
    native = Decoder()
    model = StreamingSpeechToTextModel('fake', native)
    session = model.create_session()
    with pytest.raises(RuntimeError):
        model.transcribe(pcm(1))
    with pytest.raises(RuntimeError):
        model.create_session()
    model.unload()
    assert session.result().stop_reason == 'cancelled' and native.closed


def test_conservative_overlap():
    assert _overlap('one repeated phrase', 'repeated phrase next', 'repeated phrase') == 'one repeated phrase next'
    assert _overlap('no match', 'new speech', 'unknown') == 'no match new speech'
    assert _overlap('the the cat', 'the cat sat', 'the cat') == 'the the cat sat'


class Online:
    sample_rate = 16000
    def __init__(self):
        self.sessions = []
        self.configurations = []
    def configure_hotwords(self, hotwords):
        self.configurations.append(tuple(hotwords or ()))
    def create_session(self):
        session = OnlineSession()
        self.sessions.append(session)
        return session
    def close(self):
        pass


class OnlineSession:
    def __init__(self):
        self.count = self.resets = 0
        self.closed = False
    def push(self, samples, sample_rate):
        self.count += 1
    def get_result(self):
        return SimpleNamespace(text=f'phrase{self.count}', is_endpoint=self.count == 2)
    def reset(self):
        self.resets += 1
    def finish(self):
        return SimpleNamespace(text='tail', is_endpoint=False)
    def close(self):
        self.closed = True


def test_online_endpoint_reset_and_finish():
    native = Online()
    model = StreamingSpeechToTextModel('online', native, online=True)
    updates = []
    session = model.create_session(on_transcript=updates.append)
    session.push(pcm(1))
    result = session.finish()
    assert result.text == 'phrase2 tail'
    assert [s.id for s in result.segments] == ['0', '1']
    assert native.sessions[0].resets == 1 and native.sessions[0].closed
    assert any(not u.is_final for u in updates)


def test_online_file_uses_whole_preview():
    updates = []
    model = SpeechToTextModel('online', Online(), online=True)
    result = model.transcribe(pcm(1), on_transcript=updates.append)
    assert updates[-1].text == result.text == 'phrase2 tail'


def test_reject_unsupported_recognition_options_before_decode():
    native = Decoder()
    model = SpeechToTextModel('fake', native)
    for options in [dict(hotwords=['word']), dict(timestamps='word'), dict(language='fr'), dict(task='translate')]:
        with pytest.raises(ValueError):
            model.transcribe(pcm(1), **options)
    assert native.calls == []


def test_real_whisper_file_and_live():
    import os
    from pathlib import Path
    from wfloat._recognition import load_speech_to_text, load_streaming_speech_to_text
    from wfloat._audio import normalize_audio
    cache = Path(os.environ.get('WFLOAT_TEST_MODEL_CACHE', '/tmp/wfloat-python-model-cache'))
    if not os.environ.get('WFLOAT_CORE_LIBRARY') or not (cache / 'models/openai--whisper-tiny-en/decoder.int8.onnx').exists():
        pytest.skip('requires native core and cached Whisper assets')
    source = normalize_audio(Path(__file__).parents[1] / 'sample.wav', target_sample_rate=16000)
    with load_speech_to_text('openai/whisper-tiny-en', cache_dir=cache) as model:
        result = model.transcribe(source, timestamps='segment')
        assert result.text and result.stop_reason == 'complete'
        assert result.segments and all(s.timing and s.timing.end_ms > s.timing.start_ms for s in result.segments)
    updates = []
    with load_streaming_speech_to_text('openai/whisper-tiny-en', cache_dir=cache) as model:
        session = model.create_session(on_transcript=updates.append)
        # Repeat the real recording to ensure bounded rollover is exercised.
        repeated = np.tile(source.samples, max(1, int(np.ceil(32 * 16000 / len(source.samples)))))[:32 * 16000]
        session.push(Audio(repeated, 16000))
        assert updates and any(not u.is_final for u in updates)
        result = session.finish()
        assert result.text and result.stop_reason == 'complete'
        assert all(s.id is not None for s in result.segments)


def test_external_cancel_is_observed_by_result_without_another_push():
    stop = threading.Event()
    model = StreamingSpeechToTextModel('fake', Decoder())
    session = model.create_session(cancel_event=stop)
    stop.set()
    assert session.result().stop_reason == 'cancelled'
    assert stop.is_set()


def test_fifo_files_and_unload_wait_for_native_safe_boundary():
    native = Decoder()
    entered, release = threading.Event(), threading.Event()
    native.hook = lambda: (entered.set(), release.wait(3))
    model = SpeechToTextModel('fake', native)
    results, failures = [], []
    def run():
        try:
            results.append(model.transcribe(pcm(1)))
        except BaseException as error:
            failures.append(error)
    first = threading.Thread(target=run)
    first.start()
    assert entered.wait(2)
    second = threading.Thread(target=run)
    second.start()
    # Wait for the second operation to reserve its FIFO position.
    import time
    until = time.monotonic() + 2
    while not model._queue and time.monotonic() < until:
        time.sleep(.001)
    assert model._queue
    unload = threading.Thread(target=model.unload)
    unload.start()
    until = time.monotonic() + 2
    while not model._unloading and time.monotonic() < until:
        time.sleep(.001)
    assert not native.closed
    release.set()
    for thread in (first, second, unload):
        thread.join(3)
        assert not thread.is_alive()
    assert failures == [] and len(results) == 2
    assert all(result.stop_reason == 'cancelled' for result in results)
    assert len(native.calls) == 1 and native.closed


def test_native_failure_file_keeps_completed_windows():
    native = Decoder()
    def fail_second():
        if len(native.calls) == 2:
            raise RuntimeError('failed window')
    native.hook = fail_second
    with pytest.raises(TranscriptionError) as caught:
        SpeechToTextModel('fake', native).transcribe(pcm(30))
    assert caught.value.partial_result.text == 'part1'
    assert caught.value.__cause__.args == ('failed window',)


def test_pre_cancelled_file_does_not_create_native_session():
    native = Online()
    stop = threading.Event()
    stop.set()
    result = SpeechToTextModel('online', native, online=True).transcribe(pcm(1), cancel_event=stop)
    assert result.stop_reason == 'cancelled' and native.sessions == []


def test_zipformer_hotwords_apply_to_file_live_and_reset_without_leaking():
    native = Online()
    model = StreamingSpeechToTextModel('k2-fsa/streaming-zipformer-en', native, online=True)
    phrases = ['  Wfloat\t sdk ', 'wfloat SDK', "O'Brien"]
    session = model.create_session(hotwords=phrases)
    phrases[:] = ['mutated caller input']
    session.push(pcm(1))
    session.finish()
    model.transcribe(pcm(1), hotwords=['New phrase'])
    model.create_session(hotwords=[]).cancel()
    model.transcribe(pcm(1))
    assert native.configurations == [('WFLOAT SDK', "O'BRIEN"), ('NEW PHRASE',), (), ()]


@pytest.mark.parametrize('words', [['hello\nworld'], ['hello:9'], ['hello @name'], ['café'], ['123'], ["'''"], 'hello', [None]])
def test_hotword_invalid_input_rejects_before_native_configuration(words):
    native = Online()
    model = StreamingSpeechToTextModel('zipformer', native, online=True)
    with pytest.raises((ValueError, TypeError)):
        model.create_session(hotwords=words)
    assert native.configurations == [] and native.sessions == []


def test_hotword_configuration_failure_releases_reservation_and_has_cause():
    native = Online()
    original = RuntimeError('failed to initialize beam search')
    def fail(_):
        raise original
    native.configure_hotwords = fail
    model = StreamingSpeechToTextModel('zipformer', native, online=True)
    with pytest.raises(TranscriptionError) as caught:
        model.create_session(hotwords=['test'])
    assert caught.value.__cause__ is original
    assert caught.value.partial_result.text == ''
    native.configure_hotwords = lambda _: None
    model.create_session().cancel()


def test_pinned_hotword_vocabulary_scores_and_token_identity():
    import hashlib
    from wfloat._recognition import _ZIPFORMER_VOCABULARY, _zipformer_vocabulary
    assert hashlib.sha256(_ZIPFORMER_VOCABULARY.encode()).hexdigest() == '28c02989b3cd8c2ffa974b1e33f97ec6cded170bda622ca627b7330b41c6c827'
    pieces = [line.split()[0] for line in _ZIPFORMER_VOCABULARY.splitlines()] + ['#0', '#1']
    tokens = '\n'.join(f'{piece} {index}' for index, piece in enumerate(pieces))
    assert _zipformer_vocabulary(tokens) == _ZIPFORMER_VOCABULARY
    with pytest.raises(ValueError, match='does not match'):
        _zipformer_vocabulary(tokens.replace('▁THE 4', '▁OTHER 4'))


def test_real_zipformer_hotwords_file_live_and_native_active_session_guard():
    import ctypes
    import os
    from pathlib import Path
    from wfloat._recognition import load_streaming_speech_to_text
    cache = Path(os.environ.get('WFLOAT_TEST_MODEL_CACHE', '/tmp/wfloat-python-model-cache'))
    if not os.environ.get('WFLOAT_CORE_LIBRARY') or not (cache / 'models/k2-fsa--streaming-zipformer-en/tokens.txt').exists():
        pytest.skip('requires rebuilt core and cached Zipformer')
    source = Path(__file__).parents[1] / 'sample.wav'
    from wfloat._audio import normalize_audio
    audio = normalize_audio(source, target_sample_rate=16000)
    with load_streaming_speech_to_text('k2-fsa/streaming-zipformer-en', cache_dir=cache) as model:
        native = model._native
        baseline = model.transcribe(audio)
        biased = model.transcribe(audio, hotwords=['Wfloat', 'speech recognition'])
        assert baseline.text and biased.text
        assert native._configured_hotwords == ('WFLOAT', 'SPEECH RECOGNITION')
        vocabulary = Path(native._hotword_directory.name) / 'bpe.vocab'
        assert vocabulary.exists()
        updates = []
        session = model.create_session(hotwords=['speech recognition'], on_transcript=updates.append)
        status = native._lib.wfloat_stt_model_configure_hotwords(native._model, b'OTHER', str(vocabulary).encode())
        assert status == 1  # active stream may never be invalidated by reconfiguration
        session.push(audio)
        result = session.finish()
        assert result.text and updates[-1].is_final
        assert native._configured_hotwords == ('SPEECH RECOGNITION',)
        unboosted = model.transcribe(audio, hotwords=[])
        assert unboosted.text == baseline.text
        assert native._configured_hotwords == ()
        # Failed replacement must preserve the loaded greedy recognizer.
        status = native._lib.wfloat_stt_model_configure_hotwords(native._model, b'OTHER', b'/does/not/exist.vocab')
        assert status != 0
        assert model.transcribe(audio).text == baseline.text
    assert not vocabulary.exists()

import os
import threading

import numpy as np
import pytest

from wfloat._activity import VoiceActivityDetectionModel, VadError, SpeechRange
from wfloat._audio import Audio


class Scorer:
    sample_rate = 16000
    window_size = 512
    def __init__(self):
        self.calls = self.resets = 0
        self.closed = False
        self.failure = None
    def reset(self):
        self.calls = 0
        self.resets += 1
    def score_frame(self, samples):
        self.calls += 1
        if self.failure and self.calls == self.failure:
            raise RuntimeError('native VAD failure')
        return float(samples[0])
    def close(self):
        self.closed = True


def audio(scores):
    return Audio(np.repeat(np.asarray(scores, np.float32), 512), 16000)


def options():
    return dict(min_speech_duration_ms=64, min_silence_duration_ms=64, speech_padding_ms=32)


def test_file_live_parity_irregular_chunks_and_clip_ownership():
    source = audio([0, .9, .9, .9, 0, 0, .9, .9, 0, 0])
    model = VoiceActivityDetectionModel('fake', Scorer())
    complete = model.detect(source, return_audio=True, **options())
    ends, starts, scores = [], [], []
    session = model.create_session(return_audio=True, on_speech_end=ends.append,
        on_speech_start=starts.append, on_probability=scores.append, **options())
    for start in range(0, len(source.samples), 137):
        session.push(source.samples[start:start + 137], sample_rate=16000)
    result = session.finish()
    assert len(result.segments) == len(complete.segments) == 2
    assert all(type(segment) is SpeechRange for segment in result.segments)
    for actual, full in zip(ends, complete.segments):
        assert (actual.id, actual.start_ms, actual.end_ms) == (full.id, full.start_ms, full.end_ms)
        np.testing.assert_array_equal(actual.audio.samples, full.audio.samples)
        assert len(actual.audio.samples) == round((actual.end_ms - actual.start_ms) * 16)
    assert ends[1].start_ms >= ends[0].end_ms
    assert [s.id for s in starts] == ['0', '1']
    assert len(scores) == 10
    retained = ends[0].audio.samples.copy()
    model.unload()
    np.testing.assert_array_equal(ends[0].audio.samples, retained)


def test_cancel_does_not_complete_active_segment_or_emit_end():
    model = VoiceActivityDetectionModel('fake', Scorer())
    ends = []
    session = model.create_session(on_speech_end=ends.append, **options())
    session.push(audio([.9, .9, 0, 0, .9, .9]))
    session.cancel()
    result = session.result()
    assert result.stop_reason == 'cancelled' and len(result.segments) == 1
    assert len(ends) == 1
    assert session.finish() is result


def test_cancel_from_probability_does_not_emit_start():
    model = VoiceActivityDetectionModel('fake', Scorer())
    starts = []
    session = model.create_session(min_speech_duration_ms=0, on_speech_start=starts.append,
        on_probability=lambda _: session.cancel())
    session.push(audio([.9, .9]))
    assert starts == [] and session.result().stop_reason == 'cancelled'


def test_native_failure_partial_and_callback_identity():
    native = Scorer()
    native.failure = 6
    model = VoiceActivityDetectionModel('fake', native)
    errors = []
    session = model.create_session(on_error=errors.append, **options())
    with pytest.raises(VadError) as caught:
        session.push(audio([.9, .9, 0, 0, .9, .9]))
    assert len(caught.value.partial_result.segments) == 1
    assert errors == [caught.value]
    assert isinstance(caught.value.__cause__, RuntimeError)
    native.failure = None
    sentinel = ValueError('callback failure')
    def fail(_):
        raise sentinel
    session = model.create_session(on_probability=fail)
    with pytest.raises(ValueError) as caught:
        session.push(audio([.9]))
    assert caught.value is sentinel
    model.create_session().cancel()


def test_per_operation_thresholds_and_no_long_speech_split():
    model = VoiceActivityDetectionModel('fake', Scorer())
    source = audio([.6] * 1100)
    assert not model.detect(source, speech_threshold=.8).segments
    result = model.detect(source, speech_threshold=.5)
    assert len(result.segments) == 1 and result.segments[0].end_ms > 35000
    assert result.segments[0].audio is None


def test_short_tail_probability_interval_and_no_fake_padding():
    model = VoiceActivityDetectionModel('fake', Scorer())
    scores = []
    result = model.detect(Audio(np.full(100, .9, np.float32), 16000),
        min_speech_duration_ms=0, return_audio=True, on_probability=scores.append)
    assert scores[-1].end_ms == result.segments[-1].end_ms == 6.25
    assert len(result.segments[0].audio.samples) == 100


def test_complete_cancel_preserves_requested_audio():
    stop = threading.Event()
    model = VoiceActivityDetectionModel('fake', Scorer())
    def probability(event):
        if event.start_ms >= 128:
            stop.set()
    result = model.detect(audio([.9, .9, 0, 0, .9, .9]), return_audio=True,
        on_probability=probability, cancel_event=stop, **options())
    assert result.stop_reason == 'cancelled' and len(result.segments) == 1
    assert result.segments[0].audio is not None and stop.is_set()


@pytest.mark.parametrize('bad', [dict(speech_threshold=2), dict(silence_threshold=.7),
    dict(min_speech_duration_ms=-1), dict(return_audio=1), dict(speech_padding_ms=float('inf'))])
def test_validate_before_native_work(bad):
    native = Scorer()
    model = VoiceActivityDetectionModel('fake', native)
    with pytest.raises((ValueError, TypeError)):
        model.detect(audio([.9]), **bad)
    assert native.calls == native.resets == 0


@pytest.mark.skipif(not os.environ.get('WFLOAT_CORE_LIBRARY'), reason='requires freshly built native core')
@pytest.mark.parametrize('model_path', ['/tmp/wfloat-vad-registry-model.onnx', '/tmp/wfloat-vad-v5.onnx'])
def test_real_sherpa_probabilities_reset_thresholds(model_path):
    from pathlib import Path
    from wfloat._core import create_core_vad
    if not Path(model_path).exists():
        pytest.skip('native VAD fixture missing')
    native = create_core_vad(model_name='snakers4/silero-vad', family='silero-vad', model_path=Path(model_path),
        threshold=.5, min_silence_duration_sec=.5, min_speech_duration_sec=.25,
        max_speech_duration_sec=20, sample_rate=16000, buffer_size_in_seconds=30)
    from wfloat._audio import normalize_audio
    sample = normalize_audio(Path(__file__).parents[1] / 'sample.wav', target_sample_rate=16000)
    with VoiceActivityDetectionModel('silero', native) as model:
        first, second = [], []
        detected = model.detect(sample, on_probability=first.append)
        again = model.detect(sample, on_probability=second.append)
        assert first == second and detected == again
        assert len(first) > 1 and all(0 <= x.probability <= 1 for x in first)
        assert max(x.probability for x in first) > .5
        assert model.detect(sample, speech_threshold=1).segments == []
        assert model.detect(sample, speech_threshold=0, silence_threshold=0).segments


def test_external_cancel_result_and_unload_cleanup():
    native = Scorer()
    model = VoiceActivityDetectionModel('fake', native)
    stop = threading.Event()
    session = model.create_session(cancel_event=stop)
    stop.set()
    assert session.result().stop_reason == 'cancelled'
    next_session = model.create_session()
    next_session.push(audio([.9]))
    model.unload()
    assert next_session.result().stop_reason == 'cancelled' and native.closed


def test_no_default_audio_retention_during_long_live_speech():
    model = VoiceActivityDetectionModel('fake', Scorer())
    session = model.create_session()
    session.push(audio([.9] * 2000))
    assert len(session._retained) == 0 and len(session._audio) < 512
    assert len(session.finish().segments) == 1


@pytest.mark.skipif(not os.environ.get('WFLOAT_CORE_LIBRARY'), reason='requires freshly built native core')
def test_real_vad_no_hidden_maximum_speech_split_and_live_parity():
    from pathlib import Path
    from wfloat._core import create_core_vad
    model_path = Path('/tmp/wfloat-vad-registry-model.onnx')
    if not model_path.exists():
        pytest.skip('native VAD fixture missing')
    native = create_core_vad(model_name='snakers4/silero-vad', family='silero-vad', model_path=model_path,
        threshold=.5, min_silence_duration_sec=.5, min_speech_duration_sec=.25,
        max_speech_duration_sec=20, sample_rate=16000, buffer_size_in_seconds=30)
    # Zero thresholds exercise a 35s confirmed segment through the real scorer,
    # beyond both legacy maximum-speech duration and ring-buffer capacity.
    source = Audio(np.zeros(35 * 16000, np.float32), 16000)
    with VoiceActivityDetectionModel('silero', native) as model:
        result = model.detect(source, speech_threshold=0, silence_threshold=0, return_audio=True)
        assert len(result.segments) == 1 and result.segments[0].end_ms == 35000
        assert len(result.segments[0].audio.samples) == len(source.samples)
        ends = []
        session = model.create_session(speech_threshold=0, silence_threshold=0, return_audio=True,
            on_speech_end=ends.append)
        for start in range(0, len(source.samples), 9007):
            session.push(source.samples[start:start + 9007], sample_rate=16000)
        live = session.finish()
        assert len(live.segments) == 1 and live.segments[0].end_ms == 35000
        np.testing.assert_array_equal(ends[0].audio.samples, result.segments[0].audio.samples)

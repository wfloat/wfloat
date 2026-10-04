import wave

import numpy as np
import pytest

from wfloat._audio import Audio, normalize_audio, _StreamingResampler


def test_owned_downmix_and_integer_scaling():
    source = np.array([[32767, -32768], [16000, 0]], np.int16)
    audio = normalize_audio(source, 48000)
    assert audio.samples.dtype == np.float32
    np.testing.assert_allclose(audio.samples, [-1 / 65536, 8000 / 32768])
    source[:] = 0
    assert audio.samples[1] != 0


@pytest.mark.parametrize('width', [1, 2, 3, 4])
def test_pcm_wav_widths(tmp_path, width):
    path = tmp_path / 'audio.wav'
    values = bytes([0, 128, 255]) if width == 1 else b''.join(
        n.to_bytes(width, 'little', signed=True) for n in [-(1 << (8 * width - 1)), 0, (1 << (8 * width - 1)) - 1])
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(width)
        wav.setframerate(16000)
        wav.writeframes(values)
    result = normalize_audio(path)
    np.testing.assert_allclose(result.samples[:2], [-1, 0])
    assert result.samples[2] > .99


@pytest.mark.parametrize('rate,target', [(48000, 16000), (44100, 16000), (8000, 16000), (16000, 16000)])
def test_stream_resampling_matches_file_and_retains_bounded_history(rate, target):
    rng = np.random.default_rng(7)
    samples = rng.normal(0, .1, 14003).astype(np.float32)
    whole = normalize_audio(samples, rate, target).samples
    stream = _StreamingResampler(target)
    pieces = [stream.push(Audio(samples[start:start + 37], rate)) for start in range(0, len(samples), 37)]
    assert len(stream.buffer) < 2200
    pieces.append(stream.finish())
    np.testing.assert_allclose(np.concatenate(pieces), whole, atol=1e-7)
    assert len(whole) == int(np.ceil(len(samples) * target / rate))
    assert len(stream.finish()) == 0


def test_downsampling_suppresses_aliases():
    t = np.arange(48000) / 48000
    audio = normalize_audio(np.sin(2 * np.pi * 12000 * t), 48000, 16000)
    assert np.sqrt(np.mean(audio.samples[100:-100] ** 2)) < .002


def test_save_and_empty(tmp_path):
    path = tmp_path / 'saved.wav'
    Audio(np.array([-1., 0., 1.]), 16000).save(path)
    np.testing.assert_allclose(normalize_audio(path).samples, [-1, 0, 32767/32768])
    assert normalize_audio(np.array([], np.float32), 44100, 16000).sample_rate == 16000


@pytest.mark.parametrize('samples', [b'RIFF', [0., 1.], np.array([np.nan]), np.zeros((2, 0)), np.zeros((1, 2, 3)), np.array([1j])])
def test_bad_audio(samples):
    with pytest.raises((ValueError, TypeError)):
        normalize_audio(samples, 16000)


def test_rate_validation():
    with pytest.raises(ValueError):
        normalize_audio(np.ones(2))
    with pytest.raises(ValueError):
        normalize_audio(Audio(np.ones(2), 16000), 8000)
    with pytest.raises(TypeError):
        Audio(np.ones(2), 16000.)

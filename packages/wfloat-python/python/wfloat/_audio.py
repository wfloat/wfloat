"""Owned PCM audio. Paths support uncompressed 8/16/24/32-bit PCM WAV.

Arrays use (frames,) or (frames, channels); floats are PCM amplitudes, signed
integers are scaled by their dtype range, and uint8 is unsigned PCM. Normalizing
never modifies input. Downsampling uses a windowed-sinc anti-alias filter.
"""
from __future__ import annotations

import io
import math
import wave
from dataclasses import dataclass
from numbers import Integral
from pathlib import Path

import numpy as np


def _rate(value):
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise TypeError("sample_rate must be a positive integer")
    if value <= 0:
        raise ValueError("sample_rate must be a positive integer")
    return int(value)


def _samples(value):
    if not isinstance(value, np.ndarray):
        raise TypeError("samples must be a NumPy ndarray")
    if value.ndim not in (1, 2) or (value.ndim == 2 and value.shape[1] == 0):
        raise ValueError("samples must have shape (frames,) or (frames, channels)")
    if value.dtype.kind == 'f':
        data = value.astype(np.float64, copy=True)
    elif value.dtype.kind == 'i':
        data = value.astype(np.float64) / float(2 ** (value.dtype.itemsize * 8 - 1))
    elif value.dtype == np.uint8:
        data = (value.astype(np.float64) - 128) / 128
    else:
        raise TypeError("samples must be floating PCM, signed integer PCM, or uint8 PCM")
    if not np.isfinite(data).all():
        raise ValueError("audio samples must be finite")
    if data.ndim == 2:
        data = data.mean(axis=1)
    if np.any(np.abs(data) > np.finfo(np.float32).max):
        raise ValueError("audio samples exceed float32 range")
    return np.array(data, dtype=np.float32, order='C', copy=True)


@dataclass
class Audio:
    samples: np.ndarray
    sample_rate: int

    def __post_init__(self):
        self.sample_rate = _rate(self.sample_rate)
        self.samples = _samples(self.samples)

    @property
    def duration_sec(self):
        return len(self.samples) / self.sample_rate

    def wav_bytes(self):
        """Encode mono 16-bit PCM WAV, clipping only for file encoding."""
        data = np.rint(np.clip(self.samples, -1, 1) * 32768).clip(-32768, 32767).astype('<i2')
        stream = io.BytesIO()
        with wave.open(stream, 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(self.sample_rate)
            out.writeframes(data.tobytes())
        return stream.getvalue()

    def save(self, path):
        Path(path).write_bytes(self.wav_bytes())


def _wav(path):
    try:
        with wave.open(str(path), 'rb') as source:
            channels, width, rate, frames, compression, _ = source.getparams()
            if compression != 'NONE' or width not in (1, 2, 3, 4):
                raise ValueError("Only uncompressed 8/16/24/32-bit PCM WAV is supported")
            raw = source.readframes(frames)
    except wave.Error as error:
        raise ValueError("Unsupported audio file; expected uncompressed PCM WAV") from error
    if len(raw) != frames * channels * width:
        raise ValueError("Truncated WAV audio")
    if width == 3:
        octets = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        data = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
        data = ((data ^ 0x800000) - 0x800000).astype(np.float64) / 8388608
    else:
        data = np.frombuffer(raw, dtype={1: 'u1', 2: '<i2', 4: '<i4'}[width])
    return Audio(data.reshape(-1, channels), rate)


def normalize_audio(audio, sample_rate=None, target_sample_rate=None) -> Audio:
    """Return owned mono float32 PCM; encoded bytes/file-like inputs are deferred.

    An explicit rate on an Audio/path must match its actual rate. Empty arrays
    are representable (e.g. empty TTS output); recognition/detection reject them.
    """
    if isinstance(audio, (str, Path)):
        result = _wav(audio)
    elif isinstance(audio, Audio):
        result = Audio(audio.samples, audio.sample_rate)
    elif isinstance(audio, np.ndarray):
        if sample_rate is None:
            raise ValueError("sample_rate is required for NumPy audio")
        result = Audio(audio, sample_rate)
    else:
        raise TypeError("audio must be Audio, a NumPy ndarray, or a PCM WAV path; encoded bytes are unsupported")
    if sample_rate is not None and _rate(sample_rate) != result.sample_rate:
        raise ValueError("sample_rate conflicts with the audio's actual rate")
    target = result.sample_rate if target_sample_rate is None else _rate(target_sample_rate)
    if target != result.sample_rate and len(result.samples):
        resampler = _StreamingResampler(target)
        body = resampler.push(result)
        result = Audio(np.concatenate((body, resampler.finish())), target)
    elif target != result.sample_rate:
        result = Audio(result.samples, target)
    return result


class _StreamingResampler:
    """Bounded history/lookahead with chunk-independent phase and filtering.

    A rate change flushes the previous rate run. Each run produces ceil(n*out/in)
    samples. The final filter tail is emitted by finish(), never discarded.
    """
    def __init__(self, target=16000):
        self.target = _rate(target)
        self.rate = None
        self.ended = False
        self._reset()

    def _reset(self):
        self.buffer = np.empty(0, np.float32)
        self.start = self.total = self.emitted = 0

    def push(self, audio):
        if self.ended:
            raise RuntimeError("Resampler has finished")
        tails = []
        if self.rate is not None and self.rate != audio.sample_rate:
            tails.append(self._emit(True))
            self._reset()
        self.rate = audio.sample_rate
        self.buffer = np.concatenate((self.buffer, audio.samples))
        self.total += len(audio.samples)
        tails.append(self._emit(False))
        return np.concatenate(tails)

    def _emit(self, final):
        if not self.total:
            return np.empty(0, np.float32)
        ratio = self.rate / self.target
        radius = min(1024, math.ceil(24 * ratio)) if ratio > 1 else 0
        limit = math.ceil(self.total * self.target / self.rate) if final else max(
            self.emitted, math.floor((self.total - 1 - radius) * self.target / self.rate) + 1)
        output = np.empty(max(0, limit - self.emitted), np.float32)
        for offset in range(0, len(output), 1024):
            positions = np.arange(self.emitted + offset, min(limit, self.emitted + offset + 1024)) * ratio
            left = np.floor(positions).astype(np.int64)
            fraction = positions - left
            if radius:
                indexes = np.arange(-radius, radius + 1)
                x = indexes[None, :] - fraction[:, None]
                cutoff = .9 / ratio
                weights = cutoff * np.sinc(cutoff * x) * np.where(np.abs(x) <= radius,
                    .42 + .5 * np.cos(np.pi * x / radius) + .08 * np.cos(2 * np.pi * x / radius), 0)
                weights /= weights.sum(axis=1)[:, None]
                source = np.clip(left[:, None] + indexes - self.start, 0, len(self.buffer) - 1)
                values = (self.buffer[source] * weights).sum(axis=1)
            else:
                a = self.buffer[np.clip(left - self.start, 0, len(self.buffer) - 1)]
                b = self.buffer[np.clip(left + 1 - self.start, 0, len(self.buffer) - 1)]
                values = a + (b - a) * fraction
            output[offset:offset + len(values)] = values
        self.emitted = limit
        keep = max(self.start, min(self.total, math.floor(limit * ratio) - radius))
        self.buffer = self.buffer[keep - self.start:].copy()
        self.start = keep
        return output

    def finish(self):
        if self.ended:
            return np.empty(0, np.float32)
        self.ended = True
        result = self._emit(True) if self.rate else np.empty(0, np.float32)
        self.buffer = np.empty(0, np.float32)
        return result

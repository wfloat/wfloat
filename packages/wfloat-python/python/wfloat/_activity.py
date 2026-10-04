"""Synchronous VAD with Wfloat-owned confirmation, padding, and clip retention.

Native integration uses the additive score_frame(samples)->probability API and
reset() for recurrent/left context. Older native libraries reject explicitly.
The legacy segmented detector is never fed, avoiding its maximum speech split.
"""
from __future__ import annotations

import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import numpy as np

from ._audio import Audio, normalize_audio, _StreamingResampler
from ._operations import CancellationEvent
from ._recognition import _TaskModel, _callback
from ._vad_load import load_vad_model


@dataclass(frozen=True)
class SpeechRange:
    id: str
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class SpeechSegment(SpeechRange):
    audio: Optional[Audio] = None


@dataclass(frozen=True)
class SpeechStartEvent:
    id: str
    start_ms: float


@dataclass(frozen=True)
class VadProbabilityEvent:
    probability: float
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class DetectionData:
    segments: list[SpeechSegment]


@dataclass(frozen=True)
class DetectionResult(DetectionData):
    stop_reason: str = 'complete'


@dataclass(frozen=True)
class VadSessionData:
    segments: list[SpeechRange]


@dataclass(frozen=True)
class VadSessionResult(VadSessionData):
    stop_reason: str = 'complete'


class VadError(RuntimeError):
    def __init__(self, message, partial_result):
        super().__init__(message)
        self.partial_result = partial_result


@dataclass(frozen=True)
class _Options:
    speech_threshold: float
    silence_threshold: float
    min_speech_duration_ms: float
    min_silence_duration_ms: float
    speech_padding_ms: float
    return_audio: bool


def _options(speech_threshold=.5, silence_threshold=None, min_speech_duration_ms=250,
             min_silence_duration_ms=500, speech_padding_ms=30, return_audio=False):
    def number(value, name, upper=None):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f'{name} must be a number')
        if not math.isfinite(value) or value < 0 or (upper is not None and value > upper):
            raise ValueError(f'{name} is out of range')
        return value
    speech_threshold = number(speech_threshold, 'speech_threshold', 1)
    silence_threshold = max(0, speech_threshold - .15) if silence_threshold is None else number(silence_threshold, 'silence_threshold', 1)
    if silence_threshold > speech_threshold:
        raise ValueError('silence_threshold must not exceed speech_threshold')
    for name, value in [('min_speech_duration_ms', min_speech_duration_ms),
                        ('min_silence_duration_ms', min_silence_duration_ms),
                        ('speech_padding_ms', speech_padding_ms)]:
        number(value, name, 2 ** 48)
    if not isinstance(return_audio, bool):
        raise TypeError('return_audio must be boolean')
    return _Options(speech_threshold, silence_threshold, min_speech_duration_ms,
                    min_silence_duration_ms, speech_padding_ms, return_audio)


class VoiceActivityDetectionModel(_TaskModel):
    def __init__(self, model_id, native):
        if not callable(getattr(native, 'score_frame', None)):
            raise NotImplementedError('VAD requires a native score_frame binding with recurrent/context reset; the legacy segmented detector cannot supply probabilities or unsplit speech')
        if not getattr(native, 'supports_probabilities', True):
            raise NotImplementedError('Native VAD probability scoring unavailable; rebuild the speech core with the score-frame ABI')
        super().__init__(native)
        self.model_id = model_id
        self.sample_rate = native.sample_rate
        self.window_size = native.window_size
        if self.sample_rate <= 0 or self.window_size <= 0:
            raise ValueError('Invalid native VAD frame geometry')

    def detect(self, audio, *, sample_rate=None, speech_threshold=.5, silence_threshold=None,
               min_speech_duration_ms=250, min_silence_duration_ms=500, speech_padding_ms=30,
               return_audio=False, on_probability=None, cancel_event=None) -> DetectionResult:
        config = _options(speech_threshold, silence_threshold, min_speech_duration_ms,
                          min_silence_duration_ms, speech_padding_ms, return_audio)
        _callback(on_probability, 'on_probability')
        event = CancellationEvent(cancel_event)
        pcm = normalize_audio(audio, sample_rate, self.sample_rate)
        if not len(pcm.samples):
            raise ValueError('Audio must not be empty')
        with self._file_operation(event):
            if event.is_set():
                return DetectionResult([], 'cancelled')
            session = VadSession(self, config, event, on_probability, None, None, None, file=True)
            try:
                session.push(pcm)
                return session.finish()
            finally:
                session.cancel()

    def create_session(self, *, speech_threshold=.5, silence_threshold=None,
                       min_speech_duration_ms=250, min_silence_duration_ms=500,
                       speech_padding_ms=30, return_audio=False, on_probability=None,
                       on_speech_start=None, on_speech_end=None, on_error=None, cancel_event=None) -> VadSession:
        config = _options(speech_threshold, silence_threshold, min_speech_duration_ms,
                          min_silence_duration_ms, speech_padding_ms, return_audio)
        for callback, name in [(on_probability, 'on_probability'), (on_speech_start, 'on_speech_start'),
                               (on_speech_end, 'on_speech_end'), (on_error, 'on_error')]:
            _callback(callback, name)
        event = CancellationEvent(cancel_event)
        with self._condition:
            self._ensure_open()
            if self._unloading or self._owner or self._queue or self._session:
                raise RuntimeError('Model already has active or queued work')
            session = VadSession(self, config, event, on_probability, on_speech_start, on_speech_end, on_error)
            self._session = session
            return session


class VadSession:
    def __init__(self, model, config, event, on_probability, on_start, on_end, on_error, file=False):
        self._model, self._config, self._event, self._file = model, config, event, file
        self._on_probability, self._on_start, self._on_end, self._on_error = on_probability, on_start, on_end, on_error
        self._lock = threading.RLock()
        self._thread = None
        self._done = threading.Event()
        self._error = self._result = self._callback_exception = None
        self._segments = []
        self._audio = np.empty(0, np.float32)
        self._retained = np.empty(0, np.float32)
        self._retained_start = self._position = self._previous_end = self._input = 0
        self._candidate = self._silence = self._active = None
        self._resampler = _StreamingResampler(model.sample_rate)
        try:
            model._native.reset()
        except Exception as cause:
            raise VadError(str(cause), DetectionData([]) if file else VadSessionData([])) from cause

    def _snapshot(self):
        return DetectionData(list(self._segments)) if self._file else VadSessionData(list(self._segments))

    def _cleanup(self):
        self._audio = self._retained = np.empty(0, np.float32)
        self._resampler = None
        self._candidate = self._silence = self._active = None
        self._done.set()
        if not self._file:
            self._model._release_session(self)

    def _terminal(self, reason):
        if not self._done.is_set():
            cls = DetectionResult if self._file else VadSessionResult
            self._result = cls(list(self._segments), reason)
            self._cleanup()

    def _notify(self, callback, value):
        if callback is not None and not self._event.is_set():
            try:
                callback(value)
            except BaseException as error:
                self._callback_exception = error
                raise

    @contextmanager
    def _drive(self):
        with self._lock:
            if self._thread is not None:
                raise RuntimeError('Reentrant session processing is unsupported')
            self._thread = threading.get_ident()
            try:
                yield
            except BaseException as cause:
                if not self._done.is_set():
                    if cause is self._callback_exception or not isinstance(cause, Exception):
                        self._error = cause
                    else:
                        self._error = VadError(str(cause), self._snapshot())
                        self._error.__cause__ = cause
                    self._cleanup()
                    if isinstance(self._error, VadError):
                        self._notify(self._on_error, self._error)
                    raise self._error
                raise
            finally:
                self._thread = None
                if self._event.is_set() and not self._done.is_set():
                    self._terminal('cancelled')

    def push(self, audio, *, sample_rate=None) -> None:
        if self._done.is_set():
            raise RuntimeError('Session no longer accepts audio')
        if isinstance(audio, (str, Path)):
            raise TypeError('Live push accepts PCM audio, not file paths')
        pcm = normalize_audio(audio, sample_rate)
        if not len(pcm.samples):
            raise ValueError('Audio must not be empty')
        with self._drive():
            if self._done.is_set():
                raise RuntimeError('Session no longer accepts audio')
            if self._event.is_set():
                return
            self._input += len(pcm.samples)
            self._audio = np.concatenate((self._audio, self._resampler.push(pcm)))
            self._pump(False)

    def _samples(self, ms):
        return math.ceil(ms * self._model.sample_rate / 1000)

    def _ms(self, sample):
        return sample * 1000 / self._model.sample_rate

    def _pump(self, final):
        window = self._model.window_size
        while len(self._audio) and (len(self._audio) >= window or final) and not self._event.is_set():
            count = min(window, len(self._audio))
            audio = self._audio[:count].copy()
            self._audio = self._audio[count:]
            frame = np.pad(audio, (0, window - count)) if count < window else audio
            probability = float(self._model._native.score_frame(frame))
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError('Native VAD returned an invalid probability')
            if self._event.is_set():
                break
            self._feed(audio, probability)

    def _feed(self, audio, probability):
        config = self._config
        start, end = self._position, self._position + len(audio)
        if config.return_audio:
            self._retained = np.concatenate((self._retained, audio))
        self._position = end
        self._notify(self._on_probability, VadProbabilityEvent(probability, self._ms(start), self._ms(end)))
        if self._event.is_set():
            return
        if self._active is None:
            if probability >= config.speech_threshold:
                if self._candidate is None:
                    self._candidate = start
                if end - self._candidate >= self._samples(config.min_speech_duration_ms):
                    self._active = max(self._previous_end, 0, self._candidate - self._samples(config.speech_padding_ms))
                    self._notify(self._on_start, SpeechStartEvent(str(len(self._segments)), self._ms(self._active)))
            else:
                self._candidate = None
        elif probability < config.silence_threshold:
            if self._silence is None:
                self._silence = start
            if end - self._silence >= self._samples(config.min_silence_duration_ms):
                self._close(min(end, self._silence + self._samples(config.speech_padding_ms)))
        else:
            self._silence = None
        if config.return_audio:
            keep = self._active if self._active is not None else max(self._previous_end, 0,
                (self._candidate if self._candidate is not None else self._position) - self._samples(config.speech_padding_ms))
            self._retained = self._retained[max(0, keep - self._retained_start):].copy()
            self._retained_start = keep

    def _close(self, end):
        if self._active is None or self._event.is_set():
            return
        end = max(self._active, min(end, self._position))
        ident, start = str(len(self._segments)), self._active
        audio = None
        if self._config.return_audio:
            audio = Audio(self._retained[start - self._retained_start:end - self._retained_start], self._model.sample_rate)
        segment = SpeechSegment(ident, self._ms(start), self._ms(end), audio)
        self._segments.append(segment if self._file else SpeechRange(ident, segment.start_ms, segment.end_ms))
        self._previous_end = end
        self._active = self._candidate = self._silence = None
        self._notify(self._on_end, segment)

    def finish(self) -> Union[DetectionResult, VadSessionResult]:
        if self._done.is_set():
            return self.result()
        if not self._input and not self._event.is_set():
            raise ValueError('Cannot finish a session without audio')
        with self._drive():
            if not self._done.is_set() and not self._event.is_set():
                self._audio = np.concatenate((self._audio, self._resampler.finish()))
                self._pump(True)
                if self._active is not None:
                    end = self._position if self._silence is None else min(self._position, self._silence + self._samples(self._config.speech_padding_ms))
                    self._close(end)
                self._terminal('cancelled' if self._event.is_set() else 'complete')
        return self.result()

    def cancel(self) -> None:
        self._event.set()
        if self._lock.acquire(blocking=False):
            try:
                if self._thread is None:
                    self._terminal('cancelled')
            finally:
                self._lock.release()

    def result(self) -> Union[DetectionResult, VadSessionResult]:
        """Wait for another thread to finish/cancel; does not end input."""
        if self._thread == threading.get_ident() and not self._done.is_set():
            raise RuntimeError('Cannot wait for a session result from its callback')
        while not self._done.wait(.02):
            if self._event.is_set():
                self.cancel()
        if self._error is not None:
            raise self._error
        return self._result


def load_voice_activity_detection(model_id, *, cache_dir=None, on_progress=None, cancel_event=None) -> VoiceActivityDetectionModel:
    from ._lifecycle import load_with_lifecycle
    if model_id != 'snakers4/silero-vad':
        raise ValueError('The probability VAD surface currently supports snakers4/silero-vad')
    def initialize(lease):
        legacy = load_vad_model(model_id, cache_dir=cache_dir, force_download=False)
        try:
            model = VoiceActivityDetectionModel(model_id, legacy._native_vad)
            model._asset_lease = lease
            return model
        except BaseException:
            legacy._native_vad.close()
            raise
    return load_with_lifecycle(model_id, initialize, cache_dir=cache_dir,
                               on_progress=on_progress, cancel_event=cancel_event)

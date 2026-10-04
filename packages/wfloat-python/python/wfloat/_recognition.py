"""Synchronous speech recognition using the existing native STT binding.

Offline calls are bounded to 25 seconds (Whisper must never receive a whole long
recording). Live offline models decode overlapping windows inline, starting at
four seconds and updating every two seconds. Cancellation is cooperative between
native calls: the current C ABI cannot interrupt an in-flight decoder.
"""
from __future__ import annotations

import math
import inspect
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from ._audio import Audio, normalize_audio, _StreamingResampler
from ._operations import CancellationEvent, ModelLifecycle
from ._stt_load import load_stt_model
from ._zipformer_vocabulary import _ZIPFORMER_VOCABULARY


@dataclass(frozen=True)
class TranscriptTiming:
    start_ms: float
    end_ms: float


@dataclass(frozen=True)
class TranscriptWord:
    text: str
    timing: Optional[TranscriptTiming] = None


@dataclass(frozen=True)
class TranscriptSegment:
    text: str
    timing: Optional[TranscriptTiming] = None
    words: Optional[list[TranscriptWord]] = None
    speaker_id: Optional[str] = None
    id: Optional[str] = None


@dataclass(frozen=True)
class ProvisionalTranscript:
    text: str


@dataclass(frozen=True)
class PartialTranscript:
    text: str = ''
    segments: Optional[list[TranscriptSegment]] = None
    words: Optional[list[TranscriptWord]] = None
    provisional: Optional[ProvisionalTranscript] = None


@dataclass(frozen=True)
class TranscriptionResult(PartialTranscript):
    stop_reason: str = 'complete'


@dataclass(frozen=True)
class TranscriptionUpdate:
    text: str


@dataclass(frozen=True)
class LiveTranscriptUpdate:
    id: str
    text: str
    is_final: bool
    timing: Optional[TranscriptTiming] = None
    words: Optional[list[TranscriptWord]] = None


class TranscriptionError(RuntimeError):
    def __init__(self, message, partial_result):
        super().__init__(message)
        self.partial_result = partial_result


def _callback(value, name):
    if value is not None and not callable(value):
        raise TypeError(f'{name} must be callable')
    if value is not None and (inspect.iscoroutinefunction(value) or inspect.iscoroutinefunction(getattr(value, '__call__', None))):
        raise TypeError(f'{name} must be synchronous')


class _TaskModel(ModelLifecycle):
    """FIFO blocking work; exclusive live ownership; native-safe unload."""
    def __init__(self, native):
        super().__init__()
        self._native = native
        self._condition = threading.Condition(threading.RLock())
        self._queue = []
        self._owner = None
        self._owner_thread = None
        self._session = None
        self._unloading = False
        self._asset_lease = None

    @contextmanager
    def _file_operation(self, event):
        token = object()
        with self._condition:
            self._ensure_open()
            if self._unloading or self._session is not None:
                raise RuntimeError('Model is unloading or owned by a live session')
            if self._owner_thread == threading.get_ident():
                raise RuntimeError('Reentrant inference on the same model is unsupported')
            self._queue.append((token, event))
            try:
                while self._owner is not None or self._queue[0][0] is not token:
                    if event.is_set() or self._unloading:
                        event.set()
                        break
                    self._condition.wait(.02)
                if self._unloading:
                    event.set()
                if not event.is_set():
                    self._owner = event
                    self._owner_thread = threading.get_ident()
            finally:
                self._queue.remove((token, event))
        try:
            yield
        finally:
            with self._condition:
                if self._owner is event:
                    self._owner = self._owner_thread = None
                self._condition.notify_all()

    def _release_session(self, session):
        with self._condition:
            if self._session is session:
                self._session = None
            self._condition.notify_all()

    def unload(self):
        with self._condition:
            if self._closed:
                return
            if self._owner_thread == threading.get_ident() or (
                self._session is not None and self._session._thread == threading.get_ident()):
                raise RuntimeError('Cannot unload a model from its inference callback')
            self._unloading = True
            for _, event in self._queue:
                event.set()
            if self._owner:
                self._owner.set()
            session = self._session
        if session is not None:
            session.cancel()
        with self._condition:
            while self._owner is not None or self._session is not None:
                self._condition.wait()
            if not self._closed:
                self._native.close()
                self._closed = True
                if self._asset_lease is not None:
                    self._asset_lease.release()
                    self._asset_lease = None
            self._condition.notify_all()


def _join(a, b):
    return ' '.join(x.strip() for x in (a, b) if x.strip())


def _overlap(previous, current, reference):
    """Remove only overlap anchored at both sides to its own recognition.

    Conservative on ambiguity: possible repetition beats deleting new speech.
    """
    def key(word):
        return ''.join(c for c in word.lower() if c.isalnum())
    before, after = previous.split(), current.split()
    anchor = [key(w) for w in reference.split() if key(w)]
    if not anchor:
        return _join(previous, current)
    allowance = 0 if len(anchor) < 3 else max(1, len(anchor) // 3)
    def distance(a, b):
        row = list(range(len(b) + 1))
        for i, x in enumerate(a):
            nxt = [i + 1]
            for j, y in enumerate(b):
                nxt.append(min(nxt[-1] + 1, row[j + 1] + 1, row[j] + (x != y)))
            row = nxt
        return row[-1]
    def find(words, suffix):
        best, score = 0, math.inf
        for count in range(max(1, len(anchor) - allowance), min(len(words), len(anchor) + allowance) + 1):
            part = [key(w) for w in (words[-count:] if suffix else words[:count])]
            for start in range(min(allowance, len(anchor) - 1) + 1):
                for end in range(max(start, len(anchor) - 1 - allowance), len(anchor)):
                    if part[0] != anchor[start] or part[-1] != anchor[end] or ((len(part) == 1) != (start == end)):
                        continue
                    edits = start + len(anchor) - 1 - end + distance(part[1:-1], anchor[start + 1:end])
                    if edits <= allowance and edits < score:
                        best, score = count, edits
        return best
    old, new = find(before, True), find(after, False)
    return _join(' '.join(before[:-old]), current) if old and new else _join(previous, current)


class SpeechToTextModel(_TaskModel):
    def __init__(self, model_id, native, *, online=False, segment_timestamps=False):
        super().__init__(native)
        self.model_id = model_id
        self._online = online
        self.sample_rate = native.sample_rate
        self._segment_timestamps = segment_timestamps

    def _options(self, language, task, timestamps, hotwords):
        if language not in (None, 'en'):
            raise ValueError('The currently enabled recognition assets support English only')
        if task not in (None, 'transcribe'):
            raise ValueError('Translation is not supported by the current recognition assets')
        if timestamps not in (None, 'segment', 'word'):
            raise ValueError('timestamps must be segment or word')
        if timestamps == 'word':
            raise ValueError('The native binding has no verified word alignment; token times are not word spans')
        if timestamps == 'segment' and not self._segment_timestamps:
            raise ValueError('Segment timestamps are unavailable for this model/binding')
        if hotwords is not None:
            if not isinstance(hotwords, (list, tuple)) or any(not isinstance(w, str) or not w.strip() for w in hotwords):
                raise TypeError('hotwords must be a sequence of nonempty strings')
            if not self._online:
                raise ValueError('Hotwords are supported only by streaming Zipformer')
            hotwords = _normalize_hotwords(hotwords)
        return dict(language=language, task=task, hotwords=hotwords)

    def _decode(self, samples, options, offset=0, timestamps=None):
        if not np.any(samples):
            return PartialTranscript()
        raw = self._native.transcribe_result(model_id=self.model_id, samples=samples,
            sample_rate=self.sample_rate, **options)
        segments = None
        if timestamps == 'segment' and raw.segments:
            segments = [TranscriptSegment(s.text, TranscriptTiming(
                offset + s.start_sec * 1000, offset + (s.start_sec + s.duration_sec) * 1000)) for s in raw.segments]
        return PartialTranscript(raw.text.strip(), segments)

    def transcribe(self, audio, *, sample_rate=None, language=None, task='transcribe',
                   timestamps=None, hotwords=None, on_transcript=None, cancel_event=None) -> TranscriptionResult:
        options = self._options(language, task, timestamps, hotwords)
        _callback(on_transcript, 'on_transcript')
        event = CancellationEvent(cancel_event)
        pcm = normalize_audio(audio, sample_rate, self.sample_rate)
        if not len(pcm.samples):
            raise ValueError('Audio must not be empty')
        text, segments, provisional = '', [], None
        preview = None
        with self._file_operation(event):
            if self._online and not event.is_set():
                # Reuse exactly the endpoint/reset path used by live input.
                session = TranscriptionSession(self, options, timestamps, event,
                    (lambda update: on_transcript(TranscriptionUpdate(_join(session._text, '' if update.is_final else update.text)))) if on_transcript else None,
                    None, owned=False)
                try:
                    session.push(pcm)
                    return session.finish()
                finally:
                    session.cancel()
            for start in range(0, len(pcm.samples), 25 * self.sample_rate):
                if event.is_set():
                    break
                try:
                    data = self._decode(pcm.samples[start:start + 25 * self.sample_rate], options,
                                        start / self.sample_rate * 1000, timestamps)
                except Exception as cause:
                    raise TranscriptionError(str(cause), PartialTranscript(text, segments or None)) from cause
                if event.is_set():
                    provisional = ProvisionalTranscript(data.text) if data.text else None
                    break
                text = _join(text, data.text)
                segments.extend(data.segments or [])
                if on_transcript is not None and text != preview:
                    on_transcript(TranscriptionUpdate(text))
                    preview = text
            return TranscriptionResult(text, segments or None, provisional=provisional,
                stop_reason='cancelled' if event.is_set() else 'complete')


class StreamingSpeechToTextModel(SpeechToTextModel):
    def create_session(self, *, language=None, task='transcribe', timestamps=None,
                       hotwords=None, on_transcript=None, on_error=None, cancel_event=None) -> TranscriptionSession:
        options = self._options(language, task, timestamps, hotwords)
        _callback(on_transcript, 'on_transcript')
        _callback(on_error, 'on_error')
        event = CancellationEvent(cancel_event)
        with self._condition:
            self._ensure_open()
            if self._unloading or self._owner or self._queue or self._session:
                raise RuntimeError('Model already has active or queued work')
            session = TranscriptionSession(self, options, timestamps, event, on_transcript, on_error)
            self._session = session
            return session


class TranscriptionSession:
    def __init__(self, model, options, timestamps, event, callback, on_error, owned=True):
        self._model, self._options, self._timestamps = model, options, timestamps
        self._event, self._callback, self._on_error, self._owned = event, callback, on_error, owned
        self._lock = threading.RLock()
        self._thread = None
        self._done = threading.Event()
        self._result = self._error = None
        self._callback_exception = None
        self._text = self._hypothesis = self._prefix = ''
        self._segments = []
        self._timings = []
        self._current_timing = None
        self._last = None
        self._reference = None
        self._audio = np.empty(0, np.float32)
        self._decoded = self._position = self._input = 0
        self._resampler = _StreamingResampler(model.sample_rate)
        self._native = None
        if model._online:
            try:
                model._native.configure_hotwords(options['hotwords'])
                self._native = model._native.create_session()
            except Exception as cause:
                raise TranscriptionError(str(cause), self._snapshot()) from cause

    def _snapshot(self):
        return PartialTranscript(self._text, list(self._segments), provisional=
            ProvisionalTranscript(self._hypothesis) if self._hypothesis else None)

    def _terminal(self, reason):
        if self._done.is_set():
            return
        data = self._snapshot()
        self._result = TranscriptionResult(data.text, data.segments, provisional=data.provisional, stop_reason=reason)
        self._cleanup()

    def _cleanup(self):
        try:
            if self._native is not None:
                self._native.close()
                self._native = None
        finally:
            self._audio = np.empty(0, np.float32)
            self._resampler = None
            self._done.set()
            if self._owned:
                self._model._release_session(self)

    def _notify(self, callback, value):
        if callback is not None:
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
                        self._error = TranscriptionError(str(cause), self._snapshot())
                        self._error.__cause__ = cause
                    error = self._error
                    try:
                        self._cleanup()
                    except BaseException:
                        pass  # Preserve the original failure, particularly callback/Ctrl+C.
                    if isinstance(error, TranscriptionError):
                        self._notify(self._on_error, error)
                    raise error
                raise
            finally:
                self._thread = None
                if self._event.is_set() and not self._done.is_set():
                    self._terminal('cancelled')

    def _emit(self, text, final):
        ident = str(len(self._segments))
        value = (ident, text, final)
        if value == self._last or (not text and (final or not self._last or self._last[0] != ident or not self._last[1])):
            return
        self._last = value
        if final:
            self._segments.append(TranscriptSegment(text, self._current_timing, id=ident))
            self._text = _join(self._text, text)
            self._hypothesis = ''
        self._notify(self._callback, LiveTranscriptUpdate(ident, text, final, self._current_timing))

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

    def _pump(self, final):
        rate = self._model.sample_rate
        if self._native is not None:
            step = round(.32 * rate)
            while len(self._audio) and (len(self._audio) >= step or final) and not self._event.is_set():
                count = min(step, len(self._audio))
                self._native.push(self._audio[:count], sample_rate=rate)
                self._audio = self._audio[count:].copy()
                raw = self._native.get_result()
                self._hypothesis = raw.text.strip()
                if self._event.is_set():
                    break
                self._emit(self._hypothesis, raw.is_endpoint)
                if raw.is_endpoint and not self._event.is_set():
                    self._native.reset()
            if final and not self._event.is_set():
                raw = self._native.finish()
                self._hypothesis = raw.text.strip()
                if not self._event.is_set():
                    self._emit(self._hypothesis, True)
            return
        window, overlap = 25 * rate, 3 * rate
        while len(self._audio) and not self._event.is_set() and (final or len(self._audio) >= window or (
                len(self._audio) >= 4 * rate and len(self._audio) - self._decoded >= 2 * rate)):
            count = min(window, len(self._audio))
            if final and len(self._audio) == self._decoded:
                self._emit(self._hypothesis, True)
                self._audio = np.empty(0, np.float32)
                break
            samples = self._audio[:count]
            if self._prefix and self._reference is None:
                self._reference = self._model._decode(samples[:overlap], self._options).text
                if self._event.is_set():
                    break
            data = self._model._decode(samples, self._options,
                self._position / rate * 1000, self._timestamps)
            self._decoded = count
            self._hypothesis = _overlap(self._prefix, data.text, self._reference or '')
            timed = self._timings + [s.timing for s in data.segments or [] if s.timing]
            self._current_timing = TranscriptTiming(min(t.start_ms for t in timed), max(t.end_ms for t in timed)) if timed else None
            if self._event.is_set():
                break
            quiet = count >= 2.2 * rate and np.mean(samples[-round(1.2 * rate):].astype(np.float64) ** 2) < 1e-8
            if (final and count == len(self._audio)) or quiet:
                self._emit(self._hypothesis, True)
                self._audio = self._audio[count:].copy()
                self._position += count
                self._decoded = 0
                self._prefix = self._hypothesis = ''
                self._reference = None
                self._timings = []
                self._current_timing = None
            else:
                self._emit(self._hypothesis, False)
                if count < window:
                    break
                self._prefix = self._hypothesis
                self._reference = None
                self._timings = [self._current_timing] if self._current_timing else []
                self._audio = self._audio[count - overlap:].copy()
                self._position += count - overlap
                self._decoded = overlap

    def finish(self) -> TranscriptionResult:
        if self._done.is_set():
            return self.result()
        if not self._input and not self._event.is_set():
            raise ValueError('Cannot finish a session without audio')
        with self._drive():
            if not self._done.is_set() and not self._event.is_set():
                self._audio = np.concatenate((self._audio, self._resampler.finish()))
                self._pump(True)
                self._terminal('cancelled' if self._event.is_set() else 'complete')
        return self.result()

    def cancel(self) -> None:
        self._event.set()
        # Another thread may be inside native code; it owns cleanup until return.
        if self._lock.acquire(blocking=False):
            try:
                if self._thread is None:
                    self._terminal('cancelled')
            finally:
                self._lock.release()

    def result(self) -> TranscriptionResult:
        """Wait for finish/cancel on another thread; never ends input itself."""
        if self._thread == threading.get_ident() and not self._done.is_set():
            raise RuntimeError('Cannot wait for a session result from its callback')
        while not self._done.wait(.02):
            if self._event.is_set():
                self.cancel()
        if self._error is not None:
            raise self._error
        return self._result


_MODELS = {'openai/whisper-tiny-en': False, 'UsefulSensors/moonshine-tiny': False,
           'k2-fsa/streaming-zipformer-en': True}


def _load(model_id, cls, cache_dir, on_progress, cancel_event):
    from ._lifecycle import load_with_lifecycle
    if model_id not in _MODELS:
        raise ValueError('This recognition surface currently supports Whisper tiny.en, Moonshine tiny, and streaming Zipformer en')
    whisper = model_id == 'openai/whisper-tiny-en'
    def initialize(lease):
        legacy = load_stt_model(model_id, cache_dir=cache_dir, force_download=False,
                                enable_segment_timestamps=whisper)
        try:
            model = cls(model_id, legacy._native_stt, online=_MODELS[model_id], segment_timestamps=whisper)
            model._asset_lease = lease
            return model
        except BaseException:
            legacy._native_stt.close()
            raise
    return load_with_lifecycle(model_id, initialize, cache_dir=cache_dir,
                               on_progress=on_progress, cancel_event=cancel_event)


def load_speech_to_text(model_id, *, cache_dir=None, on_progress=None, cancel_event=None) -> SpeechToTextModel:
    return _load(model_id, SpeechToTextModel, cache_dir, on_progress, cancel_event)


def load_streaming_speech_to_text(model_id, *, cache_dir=None, on_progress=None, cancel_event=None) -> StreamingSpeechToTextModel:
    return _load(model_id, StreamingSpeechToTextModel, cache_dir, on_progress, cancel_event)


def _normalize_hotwords(hotwords):
    phrases = []
    for phrase in hotwords:
        if not re.fullmatch(r"[a-zA-Z' \t]+", phrase) or not re.search('[a-zA-Z]', phrase):
            raise ValueError('Zipformer hotwords require English letters, apostrophes and spaces; blank phrases and decoder control syntax are unsupported')
        normalized = ' '.join(phrase.split()).upper()
        if normalized not in phrases:
            phrases.append(normalized)
    return tuple(phrases)


def _zipformer_vocabulary(token_text):
    expected = [line.split()[0] for line in _ZIPFORMER_VOCABULARY.strip().splitlines()] + ['#0', '#1']
    actual = [line.split() for line in token_text.strip().splitlines()]
    if actual != [[piece, str(index)] for index, piece in enumerate(expected)]:
        raise ValueError('Zipformer token asset does not match the bundled hotword vocabulary')
    return _ZIPFORMER_VOCABULARY

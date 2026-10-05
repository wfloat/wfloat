"""Synchronous speech synthesis with owned audio and demand-driven iteration.

Timing uses milliseconds on the complete recording; text offsets are Python
string indices within the original dialogue segment. Streaming requires the
native family-specific bounded unit adapter. Whole-result-only backends remain
usable for blocking generation, but cannot satisfy the streaming contract.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, replace
import ctypes
import math
import warnings
from numbers import Real
from pathlib import Path
from threading import Event, Lock
from typing import Any, Callable, Iterable, Mapping, Optional, Union
from weakref import WeakSet

import numpy as np

from ._audio import Audio
from ._operations import OperationCancelledError
from ._constants import DEFAULT_MODEL_NAME, SPEAKER_IDS, VALID_EMOTIONS
from ._model import load as _legacy_load
from ._lifecycle import ModelProgressEvent, load_with_lifecycle


@dataclass
class SpeechTiming:
    segment_index: int
    text: str
    text_start: int
    text_end: int
    start_ms: float
    end_ms: float


@dataclass
class SpeechChunk:
    audio: Audio
    start_ms: float
    timeline: list[SpeechTiming]


@dataclass
class SpeechResult:
    audio: Audio
    timeline: list[SpeechTiming]


@dataclass
class SpeechSegment:
    text: str
    voice_id: Optional[Union[str, int]] = None
    emotion: Optional[str] = None
    intensity: Optional[float] = None
    speed: Optional[float] = None
    pause_after_ms: Optional[float] = None
    temperature: Optional[float] = None
    seed: Optional[int] = None
    inference_steps: Optional[int] = None
    reference_audio: Any = None
    sample_rate: Optional[int] = None


def _number(value, name, default, *, positive=False, maximum=None):
    if value is None:
        value = default
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{name} must be a number.")
    value = float(value)
    if (not math.isfinite(value) or value < 0 or (positive and value == 0)
            or (maximum is not None and value > maximum)):
        raise ValueError(f"Invalid {name}: {value}.")
    if positive:
        native_value = ctypes.c_float(value).value
        if not math.isfinite(native_value) or native_value <= 0:
            raise ValueError(f"{name} must be representable as a positive float32.")
    return value


def _sid(voice):
    if voice is None:
        return 0
    if isinstance(voice, bool):
        raise TypeError("voice_id must be a voice name or integer.")
    if isinstance(voice, int):
        if 0 <= voice < 20:
            return voice
    elif isinstance(voice, str):
        if voice in SPEAKER_IDS:
            return SPEAKER_IDS[voice]
    else:
        raise TypeError("voice_id must be a voice name or integer.")
    raise ValueError(f"Invalid voice_id: {voice!r}.")


def _pause_samples(milliseconds, rate):
    count = milliseconds * rate / 1000
    if not math.isfinite(count) or count > 2**53 - 1:
        raise ValueError("Pause exceeds representable audio length.")
    return math.floor(count + 0.5)


def _segments(inputs, rate, voice_id, emotion, intensity, speed, gap, resolve_voice=_sid):
    if isinstance(inputs, (str, bytes, Mapping)):
        raise TypeError("segments must be a sequence of speech segments.")
    inputs = list(inputs)
    if not inputs:
        raise ValueError("Dialogue requires at least one segment.")
    gap = _number(gap, "pause_between_segments_ms", 0)
    _pause_samples(gap, rate)
    # Validate defaults even when individual segments override them.
    resolve_voice(voice_id)
    if emotion is not None:
        if not isinstance(emotion, str):
            raise TypeError("emotion must be a string.")
        if emotion not in VALID_EMOTIONS:
            raise ValueError(f"Invalid emotion: {emotion!r}.")
    _number(intensity, "intensity", 0.5, maximum=1)
    _number(speed, "speed", 1, positive=True)
    snapshot = []
    total_pause = 0
    for index, source in enumerate(inputs):
        if isinstance(source, Mapping):
            source = SpeechSegment(**source)
        if not isinstance(source, SpeechSegment):
            raise TypeError("Each segment must be a SpeechSegment or mapping.")
        segment = replace(source)
        if not isinstance(segment.text, str):
            raise TypeError("text must be a string.")
        if "\0" in segment.text:
            raise ValueError("Speech text must not contain NUL characters.")
        if not segment.text.strip():
            raise ValueError("Speech text must not be blank.")
        segment.voice_id = voice_id if segment.voice_id is None else segment.voice_id
        resolve_voice(segment.voice_id)
        segment.emotion = emotion if segment.emotion is None else segment.emotion
        if segment.emotion is None:
            segment.emotion = "neutral"
        if not isinstance(segment.emotion, str):
            raise TypeError("emotion must be a string.")
        if segment.emotion not in VALID_EMOTIONS:
            raise ValueError(f"Invalid emotion: {segment.emotion!r}.")
        segment.intensity = _number(segment.intensity, "intensity", intensity if intensity is not None else 0.5, maximum=1)
        segment.speed = _number(segment.speed, "speed", speed if speed is not None else 1, positive=True)
        segment.pause_after_ms = _number(segment.pause_after_ms, "pause_after_ms", gap if index + 1 < len(inputs) else 0)
        total_pause += _pause_samples(segment.pause_after_ms, rate)
        if total_pause > 2**53 - 1:
            raise ValueError("Total pauses exceed representable audio length.")
        snapshot.append(segment)
    return snapshot


class SpeechStream:
    """Single-pass stream; exiting its context discards unfinished work.

    No background producer runs. Each advance synthesizes at most one prepared
    unit (whose size is engine-defined), or emits at most one second of silence.
    """
    def __init__(self, model, segments, cancel_event, *, whole_result=False):
        self._model = model
        self._segments = segments
        self._cancel_event = cancel_event
        self._closed = False
        self._advancing = Lock()
        self._iterator = self._chunks(whole_result)

    def __iter__(self) -> SpeechStream:
        return self

    def __enter__(self) -> SpeechStream:
        if self._closed:
            raise RuntimeError("Speech stream is closed.")
        return self

    def __exit__(self, *exc):
        self.close()

    def _check(self):
        if self._cancel_event is not None and self._cancel_event.is_set():
            raise OperationCancelledError("Speech generation was cancelled.")
        self._model._assert_open()

    def __next__(self) -> SpeechChunk:
        if not self._advancing.acquire(False):
            raise RuntimeError("Concurrent speech stream iteration is not supported.")
        try:
            if self._closed:
                raise StopIteration
            self._check()
            with self._model._operation():
                return next(self._iterator)
        except BaseException:
            self._finish()
            raise
        finally:
            self._advancing.release()

    def _finish(self):
        self._closed = True
        self._iterator.close()
        self._segments = []
        self._model._streams.discard(self)

    def close(self) -> None:
        if not self._advancing.acquire(False):
            raise RuntimeError("Cannot close a speech stream while it is advancing; use cancel_event.")
        try:
            self._finish()
        finally:
            self._advancing.release()

    def _audio(self, generated):
        if generated.sample_rate != self._model.sample_rate:
            raise RuntimeError("Native generation returned an inconsistent sample rate.")
        samples = np.array(generated.samples, dtype=np.float32, copy=True)
        if samples.ndim != 1 or not samples.size or not np.isfinite(samples).all():
            raise RuntimeError("Native generation returned invalid or empty audio.")
        return Audio(samples=samples, sample_rate=self._model.sample_rate)

    def _chunks(self, whole_result):
        native = self._model._legacy._native_tts
        rate = self._model.sample_rate
        sample_count = 0
        pocket = self._model._pocket
        unit_api = pocket or callable(getattr(native, "prepare_wfloat_text", None)) and callable(getattr(native, "generate", None))
        for index, segment in enumerate(self._segments):
            self._check()
            if unit_api:
                if pocket:
                    from ._pocket import prepare_text
                    prepared = prepare_text(segment.text)
                else:
                    prepared = native.prepare_wfloat_text(segment.text, segment.emotion, segment.intensity)
                self._check()
                if (not prepared.text or len(prepared.text) != len(prepared.text_clean)
                        or "".join(prepared.text) != segment.text
                        or any(not raw or not clean for raw, clean in zip(prepared.text, prepared.text_clean))):
                    raise RuntimeError("Native original-text alignment does not match input.")
                cursor = 0
                for raw, clean in zip(prepared.text, prepared.text_clean):
                    self._check()
                    generated = (native.generate_pocket(clean, segment) if pocket else
                                 native.generate(clean, self._model._voice_id(segment.voice_id), segment.speed))
                    self._check()
                    audio = self._audio(generated)
                    start = sample_count / rate * 1000
                    sample_count += audio.samples.size
                    timing = SpeechTiming(index, raw, cursor, cursor + len(raw), start, sample_count / rate * 1000)
                    cursor += len(raw)
                    yield SpeechChunk(audio, start, [timing])
            elif whole_result:
                # Blocking operations may retain a complete native result. Never
                # select this branch for the public streaming API.
                result = self._model._legacy.generate(text=segment.text, voice_id=segment.voice_id,
                    emotion=segment.emotion, intensity=segment.intensity, speed=segment.speed,
                    silence_padding_sec=0)
                self._check()
                audio = self._audio(result.audio)
                start = sample_count / rate * 1000
                cursor = 0
                previous_end = 0.0
                timeline = []
                for entry in result.timeline.chunks:
                    # Native highlight offsets are UTF-8 bytes. Derive Python
                    # indices from verified original strings, never reuse bytes.
                    end = cursor + len(entry.text)
                    if not entry.text or segment.text[cursor:end] != entry.text:
                        raise RuntimeError("Native original-text alignment does not match input.")
                    if (not math.isfinite(entry.start_sec) or not math.isfinite(entry.end_sec)
                            or entry.start_sec < previous_end or entry.end_sec < entry.start_sec
                            or entry.end_sec > audio.samples.size / rate + 1 / rate):
                        raise RuntimeError("Native generation returned invalid timing.")
                    previous_end = entry.end_sec
                    timeline.append(SpeechTiming(index, entry.text, cursor, end,
                        start + entry.start_sec * 1000, start + entry.end_sec * 1000))
                    cursor = end
                if cursor != len(segment.text):
                    raise RuntimeError("Native original-text alignment does not cover input.")
                sample_count += audio.samples.size
                yield SpeechChunk(audio, start, timeline)
            else:
                raise NotImplementedError("Native TTS requires prepare_wfloat_text/generate unit APIs for bounded streaming.")
            remaining = _pause_samples(segment.pause_after_ms, rate)
            while remaining:
                self._check()
                size = min(remaining, rate)
                start = sample_count / rate * 1000
                sample_count += size
                remaining -= size
                yield SpeechChunk(Audio(np.zeros(size, dtype=np.float32), rate), start, [])
        self._check()


class TextToSpeechModel:
    def __init__(self, legacy_model, *, asset_lease=None):
        self._asset_lease = asset_lease
        self._legacy = legacy_model
        self.model_name = legacy_model.model_name
        self._pocket = getattr(legacy_model._native_tts, 'family', None) == 'pocket'
        self._standard = getattr(legacy_model._native_tts, "family", None) in ("piper", "kokoro", "kitten")
        self._voice_id = legacy_model._native_tts.voice_id if self._standard else _sid
        self.sample_rate = legacy_model.sample_rate
        self.num_speakers = legacy_model.num_speakers
        if not isinstance(self.sample_rate, int) or self.sample_rate <= 0:
            raise ValueError("Invalid native sample rate.")
        self._closed = False
        self._busy = Lock()
        self._streams = WeakSet()

    def _assert_open(self):
        if self._closed:
            raise RuntimeError("Text-to-speech model is unloaded.")

    @contextmanager
    def _operation(self):
        if not self._busy.acquire(False):
            raise RuntimeError("Concurrent or reentrant use of a speech model is not supported.")
        try:
            self._assert_open()
            yield
        finally:
            self._busy.release()

    def __enter__(self) -> TextToSpeechModel:
        self._assert_open()
        return self

    def __exit__(self, exc_type, exc, traceback) -> bool:
        try:
            self.unload()
        except BaseException:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note("Model cleanup also failed; retry unload() before deleting its assets.")
        return False

    def unload(self) -> None:
        if self._closed:
            if self._asset_lease is not None:
                self._asset_lease.release()
                self._asset_lease = None
            return
        with self._operation():
            for stream in list(self._streams):
                stream.close()
            self._legacy._native_tts.close()
            self._closed = True
            if self._asset_lease is not None:
                self._asset_lease.release()
                self._asset_lease = None

    def _create(self, segments, voice_id, emotion, intensity, speed, pause_between_segments_ms, cancel_event, whole_result, temperature=None, seed=None, inference_steps=None, reference_audio=None, sample_rate=None):
        self._assert_open()
        if cancel_event is not None and not isinstance(cancel_event, Event):
            raise TypeError("cancel_event must be a threading.Event.")
        if self._pocket:
            from ._pocket import resolve_segments
            snapshot = resolve_segments(segments, self.sample_rate, voice_id, emotion, intensity, speed,
                pause_between_segments_ms, temperature, seed, inference_steps, reference_audio, sample_rate)
        else:
            if self._standard:
                segments = list(segments) if not isinstance(segments, (str, bytes, Mapping)) else segments
                explicit_controls = {name for name, value in [('emotion', emotion), ('intensity', intensity)] if value is not None}
                if isinstance(segments, list):
                    for source in segments:
                        for name in ('emotion', 'intensity'):
                            value = source.get(name) if isinstance(source, Mapping) else getattr(source, name, None)
                            if value is not None:
                                explicit_controls.add(name)
            snapshot = _segments(segments, self.sample_rate, voice_id, emotion, intensity, speed, pause_between_segments_ms, self._voice_id)
            if self._standard:
                from ._tts_families import validate_text
                for segment in snapshot:
                    validate_text(self._legacy._native_tts.family, segment.text)
                for name in sorted(explicit_controls):
                    warnings.warn(f'{self.model_name} does not support {name}; the explicit option is ignored.', UserWarning, stacklevel=3)
            if reference_audio is not None or sample_rate is not None or any(
                    segment.reference_audio is not None or segment.sample_rate is not None for segment in snapshot):
                raise ValueError('reference_audio and sample_rate require a Pocket TTS model.')
            from ._pocket import temperature as validate_temperature, integer
            explicit = set()
            for source in [SpeechSegment('', temperature=temperature, seed=seed, inference_steps=inference_steps), *snapshot]:
                if source.temperature is not None:
                    validate_temperature(source.temperature)
                    explicit.add('temperature')
                if source.seed is not None:
                    integer(source.seed, 'seed', 0)
                    explicit.add('seed')
                if source.inference_steps is not None:
                    integer(source.inference_steps, 'inference_steps', 1)
                    explicit.add('inference_steps')
            for name in sorted(explicit):
                warnings.warn(f'Wfloat TTS does not support {name}; the explicit option is ignored.',
                              UserWarning, stacklevel=3)
        native = self._legacy._native_tts
        if not self._pocket and not whole_result and not (callable(getattr(native, "prepare_wfloat_text", None)) and callable(getattr(native, "generate", None))):
            raise NotImplementedError("Native TTS requires prepare_wfloat_text/generate unit APIs for bounded streaming.")
        stream = SpeechStream(self, snapshot, cancel_event, whole_result=whole_result)
        self._streams.add(stream)
        return stream

    def generate_stream(
        self, text: str, *,
        voice_id: Optional[Union[str, int]] = None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        speed: Optional[float] = None,
        temperature: Optional[float] = None,
        seed: Optional[int] = None,
        inference_steps: Optional[int] = None,
        reference_audio: Any = None,
        sample_rate: Optional[int] = None,
        pause_between_segments_ms: Optional[float] = 0,
        cancel_event: Optional[Event] = None,
    ) -> SpeechStream:
        return self.generate_dialogue_stream([SpeechSegment(text)], voice_id=voice_id, emotion=emotion,
            intensity=intensity, speed=speed, pause_between_segments_ms=pause_between_segments_ms, cancel_event=cancel_event,
            temperature=temperature, seed=seed, inference_steps=inference_steps,
            reference_audio=reference_audio, sample_rate=sample_rate)

    def generate_dialogue_stream(
        self, segments: Iterable[Union[SpeechSegment, Mapping[str, Any]]], *,
        voice_id: Optional[Union[str, int]] = None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        speed: Optional[float] = None,
        temperature: Optional[float] = None,
        seed: Optional[int] = None,
        inference_steps: Optional[int] = None,
        reference_audio: Any = None,
        sample_rate: Optional[int] = None,
        pause_between_segments_ms: Optional[float] = 0,
        cancel_event: Optional[Event] = None,
    ) -> SpeechStream:
        return self._create(segments, voice_id, emotion, intensity, speed, pause_between_segments_ms, cancel_event, False, temperature, seed, inference_steps, reference_audio, sample_rate)

    def generate(
        self, text: str, *,
        voice_id: Optional[Union[str, int]] = None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        speed: Optional[float] = None,
        temperature: Optional[float] = None,
        seed: Optional[int] = None,
        inference_steps: Optional[int] = None,
        reference_audio: Any = None,
        sample_rate: Optional[int] = None,
        pause_between_segments_ms: Optional[float] = 0,
        cancel_event: Optional[Event] = None,
    ) -> SpeechResult:
        return self.generate_dialogue([SpeechSegment(text)], voice_id=voice_id, emotion=emotion,
            intensity=intensity, speed=speed, pause_between_segments_ms=pause_between_segments_ms, cancel_event=cancel_event,
            temperature=temperature, seed=seed, inference_steps=inference_steps,
            reference_audio=reference_audio, sample_rate=sample_rate)

    def generate_dialogue(
        self, segments: Iterable[Union[SpeechSegment, Mapping[str, Any]]], *,
        voice_id: Optional[Union[str, int]] = None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        speed: Optional[float] = None,
        temperature: Optional[float] = None,
        seed: Optional[int] = None,
        inference_steps: Optional[int] = None,
        reference_audio: Any = None,
        sample_rate: Optional[int] = None,
        pause_between_segments_ms: Optional[float] = 0,
        cancel_event: Optional[Event] = None,
    ) -> SpeechResult:
        stream = self._create(segments, voice_id, emotion, intensity, speed, pause_between_segments_ms, cancel_event, True, temperature, seed, inference_steps, reference_audio, sample_rate)
        arrays, timeline = [], []
        with stream:
            for chunk in stream:
                arrays.append(chunk.audio.samples)
                timeline.extend(chunk.timeline)
        return SpeechResult(Audio(np.concatenate(arrays), self.sample_rate), timeline)


def load_text_to_speech(
    model_id: str = DEFAULT_MODEL_NAME, *,
    cache_dir: Optional[Union[str, Path]] = None,
    on_progress: Optional[Callable[[ModelProgressEvent], None]] = None,
    cancel_event: Optional[Event] = None,
) -> TextToSpeechModel:
    """Load cached assets, reporting progress inline; unload preserves files."""
    from ._tts_families import PIPER, KOKORO, KITTEN, load_cached as load_standard

    def initialize(lease):
        from ._pocket import MODEL_ID, load_cached
        legacy = (load_standard(model_id, cache_dir) if model_id in PIPER or model_id == KOKORO or model_id in KITTEN else
                  load_cached(cache_dir) if model_id == MODEL_ID else
                  _legacy_load(model_id, cache_dir=cache_dir, force_download=False))
        try:
            return TextToSpeechModel(legacy, asset_lease=lease)
        except BaseException:
            legacy._native_tts.close()
            raise

    return load_with_lifecycle(model_id, initialize, cache_dir=cache_dir,
                               on_progress=on_progress, cancel_event=cancel_event)

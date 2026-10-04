"""ctypes ownership adapter for native prepared-unit TTS synthesis."""
from dataclasses import dataclass
import ctypes
import math
from numbers import Real

import numpy as np


class _PreparedText(ctypes.Structure):
    _fields_ = [
        ('text', ctypes.POINTER(ctypes.c_char_p)),
        ('text_clean', ctypes.POINTER(ctypes.c_char_p)),
        ('count', ctypes.c_size_t),
    ]


class _UnitAudio(ctypes.Structure):
    _fields_ = [
        ('samples', ctypes.POINTER(ctypes.c_float)),
        ('sample_count', ctypes.c_size_t),
        ('sample_rate', ctypes.c_int32),
        ('duration_sec', ctypes.c_float),
    ]


@dataclass
class PreparedText:
    text: list[str]
    text_clean: list[str]


@dataclass
class GeneratedAudio:
    samples: np.ndarray
    sample_rate: int


def _bind(lib):
    # Bind lazily, so legacy whole-result users can still use older libraries.
    try:
        prepare = lib.wfloat_tts_model_prepare_text
        free_prepared = lib.wfloat_tts_prepared_text_destroy
        generate = lib.wfloat_tts_model_generate_unit
        free_audio = lib.wfloat_tts_unit_audio_destroy
    except AttributeError as error:
        raise RuntimeError(
            'The loaded wfloat-core library lacks incremental TTS exports; '
            'rebuild or update the native library.'
        ) from error
    prepare.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p,
                        ctypes.c_float, ctypes.POINTER(ctypes.POINTER(_PreparedText))]
    prepare.restype = ctypes.c_int32
    free_prepared.argtypes = [ctypes.POINTER(_PreparedText)]
    free_prepared.restype = None
    generate.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32,
                         ctypes.c_float, ctypes.POINTER(ctypes.POINTER(_UnitAudio))]
    generate.restype = ctypes.c_int32
    free_audio.argtypes = [ctypes.POINTER(_UnitAudio)]
    free_audio.restype = None
    return prepare, free_prepared, generate, free_audio


def _text(value, name):
    if not isinstance(value, str):
        raise TypeError(f'{name} must be a string.')
    if not value or '\0' in value:
        raise ValueError(f'{name} must be nonempty and contain no NUL characters.')
    return value.encode('utf-8')


def _open(core):
    if not core._model or not core._model.value:
        raise RuntimeError('Text-to-speech model is unloaded.')


def prepare_wfloat_text(core, text, emotion, intensity):
    _open(core)
    text_bytes = _text(text, 'text')
    emotion_bytes = _text(emotion, 'emotion')
    if isinstance(intensity, bool) or not isinstance(intensity, Real):
        raise TypeError('intensity must be a number.')
    if not math.isfinite(intensity) or not 0 <= intensity <= 1:
        raise ValueError('intensity must be finite and between 0 and 1.')
    prepare, free_prepared, _, _ = _bind(core._lib)
    result = ctypes.POINTER(_PreparedText)()
    try:
        status = prepare(core._model, text_bytes, emotion_bytes, float(intensity), ctypes.byref(result))
        if status != 0:
            raise RuntimeError(f'wfloat-core prepare text failed with status {status}.')
        if not result or not result.contents.count or not result.contents.text or not result.contents.text_clean:
            raise RuntimeError('wfloat-core returned invalid prepared text.')
        raw, clean = [], []
        for index in range(result.contents.count):
            original = result.contents.text[index]
            normalized = result.contents.text_clean[index]
            if not original or not normalized:
                raise RuntimeError('wfloat-core returned an empty prepared unit.')
            raw.append(original.decode('utf-8'))
            clean.append(normalized.decode('utf-8'))
        if ''.join(raw) != text:
            raise RuntimeError('wfloat-core original-text alignment does not match input.')
        return PreparedText(raw, clean)
    finally:
        if result:
            free_prepared(result)


def generate(core, text, sid, speed):
    _open(core)
    text_bytes = _text(text, 'text')
    if isinstance(sid, bool) or not isinstance(sid, int):
        raise TypeError('sid must be an integer.')
    if sid < 0 or sid >= core.num_speakers:
        raise ValueError('sid is outside the native speaker range.')
    if isinstance(speed, bool) or not isinstance(speed, Real):
        raise TypeError('speed must be a number.')
    # Reject float32 overflow/underflow instead of changing the requested speed.
    native_speed = ctypes.c_float(speed).value
    if not math.isfinite(native_speed) or native_speed <= 0:
        raise ValueError('speed must be finite, positive, and representable as float32.')
    _, _, generate_unit, free_audio = _bind(core._lib)
    result = ctypes.POINTER(_UnitAudio)()
    try:
        status = generate_unit(core._model, text_bytes, sid, native_speed, ctypes.byref(result))
        if status != 0:
            raise RuntimeError(f'wfloat-core generate unit failed with status {status}.')
        if not result:
            raise RuntimeError('wfloat-core returned no unit audio.')
        audio = result.contents
        if not audio.samples or not audio.sample_count or audio.sample_rate != core.sample_rate:
            raise RuntimeError('wfloat-core returned invalid unit audio.')
        # Never expose a view whose allocation is freed below or at model unload.
        samples = np.ctypeslib.as_array(audio.samples, shape=(audio.sample_count,)).copy()
        if not np.isfinite(samples).all():
            raise RuntimeError('wfloat-core returned nonfinite unit audio.')
        return GeneratedAudio(samples, int(audio.sample_rate))
    finally:
        if result:
            free_audio(result)

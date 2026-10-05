"""Pocket family adapter over the existing generic core synthesis ABI."""
import ctypes
import math
import unicodedata
import warnings
from dataclasses import replace
from numbers import Real
from pathlib import Path

import numpy as np

from . import _core
from ._audio import normalize_audio
from ._cache import get_default_cache_dir, normalize_model_name
from ._generated_model_urls import MODEL_ASSETS
from ._tts_bridge import GeneratedAudio, PreparedText, _open, _text

MODEL_ID = 'kyutai/pocket-tts'
_CORE_FAMILY_POCKET = 7
ASSET_FIELDS = ('lm_main', 'lm_flow', 'decoder', 'encoder', 'text_conditioner',
                'vocab_json', 'token_scores_json', 'reference_audio')


def temperature(value):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError('temperature must be a number.')
    native = ctypes.c_float(value).value
    if not math.isfinite(value) or value < 0 or not math.isfinite(native) or (0 < value < 2**-126):
        raise ValueError('temperature must be finite and representable as float32, and either zero or >= 2**-126.')
    return native


def integer(value, name, minimum):
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f'{name} must be an integer.')
    if not minimum <= value <= 2147483647:
        raise ValueError(f'{name} must be a signed int32 >= {minimum}.')
    return value


def reference(value, sample_rate=None):
    audio = normalize_audio(value, sample_rate)
    if not len(audio.samples) or len(audio.samples) > 10 * audio.sample_rate:
        raise ValueError('reference_audio must be nonempty and at most 10 seconds.')
    return normalize_audio(audio, target_sample_rate=24000)


def resolve_segments(inputs, rate, voice_id, emotion, intensity, speed, gap,
                     temp, seed, steps, reference_audio, sample_rate):
    from ._speech import SpeechSegment, _number, _pause_samples
    from collections.abc import Mapping
    if isinstance(inputs, (str, bytes, Mapping)):
        raise TypeError('segments must be a sequence of speech segments.')
    inputs = list(inputs)
    if not inputs:
        raise ValueError('Dialogue requires at least one segment.')
    temp = temperature(.7 if temp is None else temp)
    steps = integer(5 if steps is None else steps, 'inference_steps', 1)
    if seed is not None:
        seed = integer(seed, 'seed', 0)
    gap = _number(gap, 'pause_between_segments_ms', 0)
    _pause_samples(gap, rate)
    def voice(value):
        if value is not None and value != 'alba':
            raise ValueError("Pocket voice_id must be 'alba'.")
    voice(voice_id)
    def unsupported(source):
        for name in ('emotion', 'intensity', 'speed'):
            if getattr(source, name) is not None:
                warnings.warn(f'Pocket TTS does not support {name}; the explicit option is ignored.',
                              UserWarning, stacklevel=4)
    unsupported(SpeechSegment('', emotion=emotion, intensity=intensity, speed=speed))
    result = []
    total_pause = 0
    default_references = {}
    for index, source in enumerate(inputs):
        if isinstance(source, Mapping):
            source = SpeechSegment(**source)
        if not isinstance(source, SpeechSegment):
            raise TypeError('Each segment must be a SpeechSegment or mapping.')
        segment = replace(source)
        _text(segment.text, 'text')
        if not segment.text.strip():
            raise ValueError('Speech text must not be blank.')
        unsupported(segment)
        # Either segment selector replaces both operation selectors.
        if segment.voice_id is None and segment.reference_audio is None:
            segment.voice_id, segment.reference_audio = voice_id, reference_audio
            inherited = True
        else:
            inherited = False
        if segment.sample_rate is None:
            segment.sample_rate = sample_rate
        voice(segment.voice_id)
        if segment.voice_id is not None and segment.reference_audio is not None:
            raise ValueError('voice_id and reference_audio cannot both select the same segment voice.')
        if segment.reference_audio is not None:
            if inherited and segment.sample_rate in default_references:
                segment.reference_audio = default_references[segment.sample_rate]
            else:
                segment.reference_audio = reference(segment.reference_audio, segment.sample_rate)
                if inherited:
                    default_references[segment.sample_rate] = segment.reference_audio
        else:
            segment.voice_id = 'alba'
        segment.temperature = temp if segment.temperature is None else temperature(segment.temperature)
        segment.seed = seed if segment.seed is None else integer(segment.seed, 'seed', 0)
        segment.inference_steps = steps if segment.inference_steps is None else integer(segment.inference_steps, 'inference_steps', 1)
        segment.pause_after_ms = _number(segment.pause_after_ms, 'pause_after_ms', gap if index + 1 < len(inputs) else 0)
        total_pause += _pause_samples(segment.pause_after_ms, rate)
        if total_pause > 2**53 - 1:
            raise ValueError('Total pauses exceed representable audio length.')
        result.append(segment)
    return result


def prepare_text(text):
    """Preserve every source character; prefer word/punctuation boundaries.

    Python indices never split UTF-8 sequences. Avoid splitting combining marks,
    variation selectors, and joined emoji at the fallback hard boundary.
    """
    _text(text, 'text')
    units = []
    start = 0
    while start < len(text):
        end = min(start + 200, len(text))
        if end < len(text):
            candidates = [i + 1 for i in range(start, end)
                          if text[i].isspace() or unicodedata.category(text[i]).startswith('P')]
            if candidates and candidates[-1] > start:
                end = candidates[-1]
            boundary = end
            while boundary > start and (unicodedata.category(text[boundary]).startswith('M')
                    or text[boundary] == '\u200d' or text[boundary - 1] == '\u200d'
                    or '\U0001f3fb' <= text[boundary] <= '\U0001f3ff'):
                boundary -= 1
            # Pathological clusters may exceed the unit limit. Fall back to a
            # complete code point rather than allowing unbounded native work.
            if boundary > start:
                end = boundary
        raw = text[start:end]
        if raw.strip():
            units.append(raw)
        elif units:
            units[-1] += raw
        else:
            # Leading whitespace remains attached to the first audible unit.
            end_nonspace = end
            while end_nonspace < len(text) and text[end_nonspace].isspace():
                end_nonspace += 1
            if end_nonspace == len(text):
                raise ValueError('Speech text must not be blank.')
            # Keep whitespace in alignment, but omit it from model input below.
            tail = prepare_text(text[end_nonspace:])
            tail.text[0] = text[:end_nonspace] + tail.text[0]
            return tail
        start = end
    return PreparedText(units, [unit.strip() for unit in units])


class PocketTts:
    family = 'pocket'
    close = _core.CoreTts.close
    __del__ = _core.CoreTts.__del__

    def __init__(self, paths):
        self._model = ctypes.c_void_p()
        self._lib = _core._prepare_library(_core._load_core_library())
        self.default_reference = reference(paths['reference_audio'])
        self._config_bytes = {key + '_path': str(paths[key]).encode('utf-8')
                              for key in ASSET_FIELDS if key != 'reference_audio'}
        config = _core._WfloatTtsModelConfig(model_id=MODEL_ID.encode(), family=_CORE_FAMILY_POCKET,
                    num_threads=1, provider=b'cpu', max_num_sentences=1, silence_scale=.2,
                    **self._config_bytes)
        try:
            status = self._lib.wfloat_tts_model_create(ctypes.byref(config), ctypes.byref(self._model))
            if status:
                raise RuntimeError(f'wfloat-core Pocket creation failed with status {status}.')
            info = _core._WfloatTtsModelInfo()
            status = self._lib.wfloat_tts_model_get_info(self._model, ctypes.byref(info))
            if status:
                raise RuntimeError(f'wfloat-core Pocket info failed with status {status}.')
            self.sample_rate = int(info.sample_rate)
            self.num_speakers = int(info.num_speakers)
        except BaseException:
            self.close()
            raise

    def generate_pocket(self, text, segment):
        _open(self)
        pcm = (segment.reference_audio if segment.reference_audio is not None else self.default_reference).samples
        entries = [_core._WfloatStringMapEntry(b'temperature', str(segment.temperature).encode())]
        if segment.seed is not None:
            entries.append(_core._WfloatStringMapEntry(b'seed', str(segment.seed).encode()))
        extra = (_core._WfloatStringMapEntry * len(entries))(*entries)
        options = _core._WfloatTtsSynthesizeOptions(text=_text(text, 'text'), speed=1,
            num_steps=segment.inference_steps, extra_entries=extra, extra_entry_count=len(extra),
            reference_audio=pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            reference_audio_sample_count=pcm.size, reference_audio_sample_rate=24000)
        result = ctypes.POINTER(_core._WfloatTtsSynthesisResult)()
        try:
            status = self._lib.wfloat_tts_model_synthesize(self._model, ctypes.byref(options), None, None, ctypes.byref(result))
            if status:
                raise RuntimeError(f'wfloat-core Pocket synthesis failed with status {status}.')
            if not result or not result.contents.audio.samples or not result.contents.audio.sample_count:
                raise RuntimeError('wfloat-core returned empty Pocket audio.')
            audio = result.contents.audio
            samples = np.ctypeslib.as_array(audio.samples, shape=(audio.sample_count,)).copy()
            if audio.sample_rate != self.sample_rate or not np.isfinite(samples).all():
                raise RuntimeError('wfloat-core returned invalid Pocket audio.')
            return GeneratedAudio(samples, int(audio.sample_rate))
        finally:
            if result:
                self._lib.wfloat_tts_synthesis_result_destroy(result)


def load_cached(cache_dir):
    """Called only after the existing lifecycle has verified and leased assets."""
    from ._model import Model
    entry = MODEL_ASSETS[MODEL_ID]
    if entry.get('family') != 'pocket':
        raise ValueError('Pocket registry entry must have family pocket.')
    root = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    directory = root / 'models' / normalize_model_name(MODEL_ID)
    paths = {key: directory / Path(entry[key]['path']).name for key in ASSET_FIELDS}
    return Model(MODEL_ID, PocketTts(paths))

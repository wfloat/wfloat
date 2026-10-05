"""Internal Piper/Kokoro/Kitten adapters over the generic synthesis ABI.

Kitten 0.8 requires the rebuilt WFLOAT_KITTEN_08 frontend overlay; SDK wiring
does not establish runtime fidelity or qualification.
"""
import ctypes
import json
from pathlib import Path

import numpy as np

from . import _core
from ._cache import get_default_cache_dir, normalize_model_name
from ._generated_model_urls import MODEL_ASSETS, SHARED_ASSETS
from ._pocket import prepare_text
from ._tts_bridge import GeneratedAudio, PreparedText, _open, _text

PIPER = {
    'rhasspy/piper-' + name: (speakers, voice)
    for name, speakers, voice in (
        ('en_US-lessac-medium', 1, 'en-us'), ('en_US-amy-medium', 1, 'en-us'),
        ('en_GB-alba-medium', 1, 'en-gb-x-rp'), ('de_DE-thorsten-medium', 1, 'de'),
        ('fr_FR-siwis-medium', 1, 'fr'), ('en_US-libritts-high', 904, 'en-us'),
        ('en_US-ryan-medium', 1, 'en-us'))
}
KOKORO = 'hexgrad/Kokoro-82M'
KITTEN = ('KittenML/kitten-tts-nano-0.8', 'KittenML/kitten-tts-mini-0.8')
KITTEN_VOICES = ('Jasper', 'Bella', 'Bruno', 'Luna', 'Hugo', 'Rosie', 'Leo', 'Kiki')
KITTEN_EXPORT_VOICES = tuple(f'expr-voice-{number}-{gender}' for number in range(2, 6) for gender in ('m', 'f'))
KOKORO_VOICES = ('af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang em_santa').split()


def validate_text(family, text):
    _text(text, 'text')
    if not text.strip():
        raise ValueError('Speech text must not be blank.')
    if family == 'kitten' and len(text) > 65536:
        raise ValueError('Kitten text exceeds 65536 codepoints per call.')


def kokoro_language(sid):
    if isinstance(sid, bool) or not isinstance(sid, int) or not 0 <= sid < 54:
        raise ValueError('Invalid Kokoro voice_id.')
    prefix = KOKORO_VOICES[sid][0]
    if prefix == 'j':
        raise ValueError('Kokoro Japanese voices require a Japanese frontend; the current Sherpa frontend routes Han characters through the Chinese lexicon.')
    # Use voice IDs present in the shared eSpeak tree: en is British English,
    # fr is French, and pt is Brazilian Portuguese.
    return dict(a='en-us', b='en', e='es', f='fr', h='hi', i='it', p='pt', z='cmn')[prefix]


def configuration(model_id, config_path=None):
    from ._speech import _number
    if model_id in KITTEN:
        aliases = {name: sid for names in (KITTEN_VOICES, KITTEN_EXPORT_VOICES)
                   for sid, name in enumerate(names)}
        return dict(family='kitten', sample_rate=24000, num_speakers=8,
                    aliases=aliases, length_scale=1)
    if model_id == KOKORO:
        return dict(family='kokoro', sample_rate=24000, num_speakers=54,
                    aliases=dict(zip(KOKORO_VOICES, range(54))), length_scale=1)
    if model_id not in PIPER:
        raise ValueError(f'Unsupported standard TTS model: {model_id}.')
    speakers, voice = PIPER[model_id]
    c = json.loads(Path(config_path).read_text(encoding='utf-8'))
    # The pinned LibriTTS high JSON predates the explicit phoneme_type key.
    phoneme_type = c.get('phoneme_type', 'espeak' if model_id == 'rhasspy/piper-en_US-libritts-high' else None)
    if (c.get('audio', {}).get('sample_rate') != 22050 or c.get('num_speakers') != speakers
            or c.get('espeak', {}).get('voice') != voice or phoneme_type != 'espeak'):
        raise ValueError(f'Piper metadata does not match {model_id}.')
    aliases = c.get('speaker_id_map')
    if not isinstance(aliases, dict) or any(type(v) is not int or not 0 <= v < speakers for v in aliases.values()):
        raise ValueError('Invalid Piper speaker_id_map.')
    inference = c.get('inference', {})
    scales = {dest: _number(inference.get(src), src, None, positive=True)
              for src, dest in [('noise_scale', 'noise_scale'), ('noise_w', 'noise_scale_w'), ('length_scale', 'length_scale')]}
    return dict(family='piper', sample_rate=22050, num_speakers=speakers, aliases=aliases, **scales)


class StandardTts:
    __del__ = _core.CoreTts.__del__

    def __init__(self, model_id, paths, data_dir):
        self._model = ctypes.c_void_p()
        self._closed = False
        self.model_id, self.paths, self.data_dir = model_id, paths, data_dir
        self.config = configuration(model_id, paths.get('model_config'))
        self.family = self.config['family']
        self.sample_rate = self.config['sample_rate']
        self.num_speakers = self.config['num_speakers']
        self._lib = _core._prepare_library(_core._load_core_library())
        self._chinese = False
        self._open_session(False)

    def voice_id(self, voice):
        sid = 0 if voice is None else self.config['aliases'].get(voice, voice) if isinstance(voice, str) else voice
        if isinstance(sid, bool) or not isinstance(sid, int) or not 0 <= sid < self.num_speakers:
            raise ValueError(f'Invalid {self.model_id} voice_id: {voice!r}.')
        if self.family == 'kokoro':
            kokoro_language(sid)
        return sid

    def _open_session(self, chinese):
        # FSTs are session-wide. Destroy before replacement; never hold two models.
        _core.CoreTts.close(self)
        fields = dict(model_path=str(self.paths['model_onnx']).encode(),
                      tokens_path=str(self.paths['model_tokens']).encode(), data_dir=str(self.data_dir).encode())
        if self.family == 'kitten':
            fields['voices_path'] = str(self.paths['model_voices']).encode()
        if self.family == 'kokoro':
            fields.update(voices_path=str(self.paths['model_voices']).encode(),
                          lexicon_path=str(self.paths['lexicon_zh']).encode(), lang=b'en-us',
                          rule_fsts=','.join(str(self.paths[key]) for key in
                              ('rule_date_zh', 'rule_number_zh', 'rule_phone_zh')).encode() if chinese else b'')
        config = _core._WfloatTtsModelConfig(model_id=self.model_id.encode(),
            family={'piper': 2, 'kokoro': 4, 'kitten': 6}[self.family], num_threads=1, provider=b'cpu',
            max_num_sentences=1, silence_scale=1, length_scale=self.config['length_scale'],
            noise_scale=self.config.get('noise_scale', 0), noise_scale_w=self.config.get('noise_scale_w', 0), **fields)
        try:
            status = self._lib.wfloat_tts_model_create(ctypes.byref(config), ctypes.byref(self._model))
            if status:
                raise RuntimeError(f'wfloat-core TTS creation failed with status {status}.')
            info = _core._WfloatTtsModelInfo()
            status = self._lib.wfloat_tts_model_get_info(self._model, ctypes.byref(info))
            if status or (info.sample_rate, info.num_speakers) != (self.sample_rate, self.num_speakers):
                raise RuntimeError('TTS runtime metadata does not match the pinned export.')
            self._chinese = chinese
        except BaseException:
            _core.CoreTts.close(self)
            raise

    def close(self):
        self._closed = True
        _core.CoreTts.close(self)

    def prepare_wfloat_text(self, text, emotion, intensity):
        # Adapter protocol name only: do not apply Wfloat's English cleaner.
        validate_text(self.family, text)
        if self.family == 'kitten':
            # Native v8 owns normalization/chunk/style context and tail trimming.
            # Preserve whitespace and the entire original Python source range.
            return PreparedText([text], [text])
        return prepare_text(text)

    def generate(self, text, sid, speed):
        from ._speech import _number
        if self._closed:
            raise RuntimeError('Text-to-speech model is unloaded.')
        validate_text(self.family, text)
        text_bytes = _text(text, 'text')
        sid = self.voice_id(sid)
        speed = _number(speed, 'speed', 1, positive=True)
        entries = []
        if self.family == 'kokoro':
            language = kokoro_language(sid)
            chinese = language == 'cmn'
            if not self._model.value or chinese != self._chinese:
                self._open_session(chinese)
            entries.append(_core._WfloatStringMapEntry(b'lang', b'en-us' if chinese else language.encode()))
        _open(self)
        extra = (_core._WfloatStringMapEntry * len(entries))(*entries)
        options = _core._WfloatTtsSynthesizeOptions(text=text_bytes, sid=sid, speed=speed,
            extra_entries=extra, extra_entry_count=len(entries))
        result = ctypes.POINTER(_core._WfloatTtsSynthesisResult)()
        try:
            status = self._lib.wfloat_tts_model_synthesize(self._model, ctypes.byref(options), None, None, ctypes.byref(result))
            if status:
                raise RuntimeError(f'wfloat-core TTS synthesis failed with status {status}.')
            if not result or not result.contents.audio.samples or not result.contents.audio.sample_count:
                raise RuntimeError('wfloat-core returned empty TTS audio.')
            audio = result.contents.audio
            samples = np.ctypeslib.as_array(audio.samples, shape=(audio.sample_count,)).copy()
            if audio.sample_rate != self.sample_rate or not np.isfinite(samples).all():
                raise RuntimeError('wfloat-core returned invalid TTS audio.')
            return GeneratedAudio(samples, int(audio.sample_rate))
        finally:
            if result:
                self._lib.wfloat_tts_synthesis_result_destroy(result)


def load_cached(model_id, cache_dir):
    from ._model import Model
    if model_id not in PIPER and model_id != KOKORO and model_id not in KITTEN:
        raise ValueError(f'Unsupported standard TTS model: {model_id}.')
    entry = MODEL_ASSETS[model_id]
    expected_family = 'piper' if model_id in PIPER else 'kitten' if model_id in KITTEN else 'kokoro'
    if entry.get('family') != expected_family:
        raise ValueError(f'{model_id} registry family must be {expected_family}.')
    root = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    directory = root / 'models' / normalize_model_name(model_id)
    required = ['model_onnx', 'model_tokens']
    if expected_family == 'piper':
        required.append('model_config')
    else:
        required.append('model_voices')
    if expected_family == 'kokoro':
        required.extend(['lexicon_zh', 'rule_date_zh', 'rule_number_zh', 'rule_phone_zh'])
    paths = {key: directory / Path(entry[key]['path']).name for key in required}
    data_dir = root / 'espeak' / SHARED_ASSETS['espeak_ng_data_zip']['sha256'] / 'espeak-ng-data'
    for path in paths.values():
        if not path.is_file():
            raise FileNotFoundError(path)
    if not data_dir.is_dir() or not (data_dir.parent / '.ready').is_file():
        raise FileNotFoundError('TTS requires lifecycle-installed shared espeak-ng-data.')
    return Model(model_id, StandardTts(model_id, paths, data_dir))

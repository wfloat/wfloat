"""Staged STT contracts using tiny fixtures and fake decoders, never inference."""
import ctypes
import hashlib
import io
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

import wfloat
from wfloat import _assets, _core, _lifecycle
from wfloat._recognition import SpeechToTextModel, StreamingSpeechToTextModel, _join, _overlap
from wfloat._stt_contracts import MULTILINGUAL_WHISPER, MOONSHINE_V2, WHISPER_LANGUAGES, ZIPFORMER_LANGUAGES

FRENCH = 'shaojieli/streaming-zipformer-fr'
MANDARIN = 'k2-fsa/streaming-zipformer-zh-en'
MODELS = sorted(MULTILINGUAL_WHISPER) + [MOONSHINE_V2, FRENCH, MANDARIN]


@pytest.mark.parametrize('model_id,language,expected', [
    ('openai/whisper-small', 'FR-fr', 'fr'),
    ('openai/whisper-base', 'zh_Hans_CN', 'zh'),
    ('openai/whisper-tiny', 'EN-us', 'en'),
    (MOONSHINE_V2, 'en-US', 'en'),
    (FRENCH, 'fr-FR', None), (MANDARIN, 'zh-CN', None),
])
def test_regional_language_normalization_and_native_forwarding(model_id, language, expected):
    from wfloat._stt import SttModel
    native = Offline()
    model = SpeechToTextModel(model_id, native)
    try:
        # Shared option processing also feeds streaming sessions.
        assert model._options(language, 'transcribe', None, None)['language'] == expected
        model.transcribe(np.ones(160), sample_rate=16000, language=language)
        assert native.calls[-1]['language'] == expected
        SttModel(model_id, native).transcribe(audio=[1.] * 160, sample_rate=16000, language=language)
        assert native.calls[-1]['language'] == expected
    finally:
        model.unload()


@pytest.mark.parametrize('language', ['', 'auto', 'French', 'fr-', 'fr-F', ' fr', 'fr\n',
                                      'fr--FR', 'fr-123456789', 'fK', [], 1])
def test_language_code_rejects_malformed_or_unsupported_values(language):
    from wfloat._stt_contracts import validate_options
    with pytest.raises(ValueError):
        validate_options('openai/whisper-small', language, 'transcribe')


def test_regional_language_retains_model_restrictions():
    from wfloat._stt_contracts import validate_options
    for model_id, language in [(FRENCH, 'en-US'), (MOONSHINE_V2, 'fr-FR'),
                               ('nvidia/parakeet-tdt-0.6b-v3', 'en-US')]:
        with pytest.raises(ValueError):
            validate_options(model_id, language, 'transcribe')
    assert validate_options('openai/whisper-small', None, 'transcribe') is None


@pytest.mark.parametrize('start,duration,text', [
    (.1, 0, 'Bonjour'), (-.1, .2, 'Bonjour'), (.2, -.1, 'Bonjour'),
    (float('nan'), .2, 'Bonjour'), (.1, float('inf'), 'Bonjour'),
    (float('inf'), .2, 'Bonjour'), (.1, float('nan'), 'Bonjour'),
    (1., .2, 'Bonjour'), (1.1, .2, 'Bonjour'), (1.1, .2, ' '),
    ('0', .2, 'Bonjour'), (.1, .2, None),
])
def test_requested_whisper_timing_rejects_invalid_native_segments(start, duration, text):
    native = Offline()
    native.transcribe_result = lambda **kwargs: SimpleNamespace(text='Bonjour', segments=[
        SimpleNamespace(text=text, start_sec=start, duration_sec=duration)])
    model = SpeechToTextModel('openai/whisper-small', native, segment_timestamps=True)
    try:
        with pytest.raises(wfloat.TranscriptionError, match='segment timing'):
            model.transcribe(np.ones(16000), sample_rate=16000, timestamps='segment')
        # Unrequested timing must not invalidate a text-only result.
        assert model.transcribe(np.ones(16000), sample_rate=16000).text == 'Bonjour'
    finally:
        model.unload()


@pytest.mark.parametrize('segments', [None, []])
def test_requested_whisper_timing_requires_segments_only_for_nonempty_text(segments):
    native = Offline()
    raw = SimpleNamespace(text='Bonjour', segments=segments)
    native.transcribe_result = lambda **kwargs: raw
    model = SpeechToTextModel('openai/whisper-tiny', native, segment_timestamps=True)
    try:
        with pytest.raises(wfloat.TranscriptionError, match='requested segment timestamps'):
            model.transcribe(np.ones(16000), sample_rate=16000, timestamps='segment')
        raw.text = ' '
        assert model.transcribe(np.ones(16000), sample_rate=16000, timestamps='segment').text == ''
        raw.text = 'Bonjour'
        raw.segments = [SimpleNamespace(text='Bonjour', start_sec=.1, duration_sec=.92)]
        result = model.transcribe(np.ones(16000), sample_rate=16000, timestamps='segment')
        assert result.segments[0].timing.end_ms == 1000
    finally:
        model.unload()


@pytest.mark.parametrize('seconds,start,duration,offset,expected_end', [
    (8, 7.6, 1., 0, 8000),  # Original 7.6–8.6 s endpoint on an 8 s clip.
    (1, .1, 1., 0, 1000),
    (1, .1, 100., 0, 1000),  # No arbitrary overshoot tolerance.
    (1, .1, .2, 0, 300),
    (8, 7.6, 1., 25000, 33000),  # Clamp before global offset.
])
def test_whisper_clamps_valid_endpoints_to_decode_window(seconds, start, duration, offset, expected_end):
    native = Offline()
    native.transcribe_result = lambda **kwargs: SimpleNamespace(text=' They fled.', segments=[
        SimpleNamespace(text=' They fled.', start_sec=start, duration_sec=duration)])
    model = SpeechToTextModel('openai/whisper-base', native, segment_timestamps=True)
    try:
        result = model._decode(np.ones(seconds * 16000), {}, offset, 'segment')
        segment = result.segments[0]
        assert segment.text == ' They fled.'
        assert segment.timing.start_ms == pytest.approx(offset + start * 1000)
        assert segment.timing.end_ms == pytest.approx(expected_end)
    finally:
        model.unload()


class Offline:
    sample_rate = 16000
    def __init__(self):
        self.calls = []
        self.closed = False
    def close(self):
        self.closed = True
    def transcribe_result(self, **options):
        self.calls.append(options)
        text = 'translated' if options['task'] == 'translate' else '你好'
        segment = SimpleNamespace(text=text, start_sec=.1, duration_sec=.2)
        return SimpleNamespace(text=text, segments=[segment])


class Online(Offline):
    def __init__(self, texts):
        super().__init__()
        self.texts = texts
        self.sessions = []
    def configure_hotwords(self, words):
        assert words is None  # New Zipformers must not synthesize BPE scores.
    def create_session(self):
        owner = self
        class Session:
            closed = False
            resets = 0
            def push(self, samples, sample_rate):
                pass
            def get_result(self):
                return SimpleNamespace(text=owner.texts[0], is_endpoint=True)
            def reset(self):
                self.resets += 1
            def finish(self):
                return SimpleNamespace(text=owner.texts[1], is_endpoint=False)
            def close(self):
                self.closed = True
        session = Session()
        self.sessions.append(session)
        return session


@pytest.fixture
def registry(monkeypatch, tmp_path):
    entries, payloads = {}, {}
    for model_id in MODELS:
        if model_id == MOONSHINE_V2:
            family = 'moonshine'
            names = dict(encoder='encoder_model.ort', merged_decoder='decoder_model_merged.ort', tokens='tokens.txt')
        else:
            family = 'whisper' if model_id in MULTILINGUAL_WHISPER else 'zipformer-transducer'
            names = dict(encoder='encoder.onnx', decoder='decoder.onnx', tokens='tokens.txt')
            if family == 'zipformer-transducer':
                names['joiner'] = 'joiner.onnx'
        names['license'] = 'LICENSE'
        entry = dict(family=family)
        for role, name in names.items():
            path = f'/models/{model_id}/int8/{name}'
            data = (model_id + ':' + role).encode()
            payloads[path] = data
            entry[role] = dict(path=path, sha256=hashlib.sha256(data).hexdigest(), sizeBytes=len(data))
        entries[model_id] = entry
    monkeypatch.setattr(_assets, 'MODEL_ASSETS', entries)
    monkeypatch.setattr(_lifecycle, 'MODEL_ASSETS', entries)
    requests = []
    def download(request, **kwargs):
        path = request.full_url.removeprefix(_assets.REGISTRY_ORIGIN)
        requests.append(path)
        data = payloads[path]
        response = io.BytesIO(data)
        response.status, response.headers = 200, {'Content-Length': str(len(data))}
        return response
    monkeypatch.setattr(_lifecycle, 'urlopen', download)
    yield SimpleNamespace(entries=entries, requests=requests, root=tmp_path)
    for transfer in list(_lifecycle._transfers.values()):
        if transfer.asset.path.is_relative_to(tmp_path):
            transfer.stop.set()
            assert transfer.done.wait(5)


@pytest.mark.parametrize('model_id', MODELS)
@pytest.mark.parametrize('load', [wfloat.load_speech_to_text, wfloat.load_streaming_speech_to_text])
def test_public_load_roles_cache_and_leases(registry, model_id, load):
    r = registry
    native = Offline()
    with patch('wfloat._stt_load.create_core_stt', return_value=native) as create, \
            patch('wfloat._stt_assets.download_file', side_effect=AssertionError('legacy network')):
        for _ in range(2):
            model = load(model_id, cache_dir=r.root)
            config = create.call_args.kwargs
            assert config['family'] == r.entries[model_id]['family']
            assert config['language'] is None
            assert config['task'] == ('transcribe' if model_id in MULTILINGUAL_WHISPER else None)
            assert config['enable_segment_timestamps'] == (model_id in MULTILINGUAL_WHISPER)
            assert not config['enable_token_timestamps']
            for role in ['encoder', 'decoder', 'tokens', 'joiner']:
                source_role = 'merged_decoder' if role == 'decoder' and model_id == MOONSHINE_V2 else role
                if source_role in r.entries[model_id]:
                    assert config[role + '_path'].read_bytes() == (model_id + ':' + source_role).encode()
            if model_id == MOONSHINE_V2:
                assert config['decoder_path'].name == 'decoder_model_merged.ort'
                assert all(config[role + '_path'] is None for role in ['preprocessor', 'uncached_decoder', 'cached_decoder'])
            with pytest.raises(wfloat.ModelAssetsInUseError):
                wfloat.delete_model_assets(model_id, cache_dir=r.root)
            model.unload()
        assert len(r.requests) == len(r.entries[model_id]) - 1
    wfloat.delete_model_assets(model_id, cache_dir=r.root)


@pytest.mark.parametrize('model_id', sorted(MULTILINGUAL_WHISPER))
def test_whisper_language_translation_windows_and_segment_offsets(model_id):
    native = Offline()
    model = SpeechToTextModel(model_id, native, segment_timestamps=True)
    result = model.transcribe(np.ones(26 * 16000), sample_rate=16000, language='fr', task='translate', timestamps='segment')
    assert result.text == 'translated translated'
    assert [len(call['samples']) for call in native.calls] == [25 * 16000, 16000]
    assert all(call['language'] == 'fr' and call['task'] == 'translate' for call in native.calls)
    assert [segment.timing.start_ms for segment in result.segments] == [100, 25100]
    model.transcribe(np.ones(160), sample_rate=16000)
    assert native.calls[-1]['language'] is None and native.calls[-1]['task'] == 'transcribe'
    assert len(WHISPER_LANGUAGES) == 99
    for language in WHISPER_LANGUAGES:
        assert model._options(language, 'transcribe', None, None)['language'] == language
    for options in [dict(language='xx'), dict(language='French'), dict(language=''), dict(language=[]),
                    dict(task='translate-to-French'), dict(hotwords=['test']), dict(timestamps='word')]:
        with pytest.raises((ValueError, TypeError)):
            model.transcribe(np.ones(160), sample_rate=16000, **options)


@pytest.mark.parametrize('model_id,language,texts,expected', [
    (FRENCH, 'fr', ['Bonjour à tous.', 'Ça va ?'], 'Bonjour à tous. Ça va ?'),
    (MANDARIN, 'zh', ['你好，', '世界！'], '你好，世界！'),
    (MANDARIN, 'en', ['hello', 'world'], 'hello world'),
])
def test_streaming_language_compatibility_endpoint_join_and_reset(model_id, language, texts, expected):
    native = Online(texts)
    model = StreamingSpeechToTextModel(model_id, native, online=True)
    updates = []
    session = model.create_session(language=language, on_transcript=updates.append)
    assert session._options['language'] is None
    session.push(np.ones(5120), sample_rate=16000)
    result = session.finish()
    assert result.text == expected and updates[-1].is_final
    assert native.sessions[-1].resets == 1 and native.sessions[-1].closed
    assert all(segment.words is None and segment.timing is None for segment in result.segments)
    file_result = model.transcribe(np.ones(5120), sample_rate=16000, language=language)
    assert file_result.text == expected
    session = model.create_session(language=language)
    session.cancel()
    assert native.sessions[-1].closed
    for options in [dict(language='ja'), dict(task='translate'), dict(hotwords=['test']),
                    dict(hotwords=[]), dict(timestamps='word'), dict(timestamps='segment')]:
        count = len(native.sessions)
        with pytest.raises(ValueError):
            model.create_session(**options)
        assert len(native.sessions) == count


def test_cjk_and_french_overlap_preserves_text():
    assert _overlap('你好世界', '世界今天很好', '世界') == '你好世界今天很好'
    assert _overlap('你好，世界。', '世界今天很好', '世界') == '你好，世界今天很好'
    assert _overlap('你好', '世界', '没有匹配') == '你好世界'
    assert _overlap('bonjour à tous', 'à tous les amis', 'à tous') == 'bonjour à tous les amis'
    assert _join('你好，', '世界！') == '你好，世界！'
    assert _join('bonjour', 'été') == 'bonjour été'


def test_moonshine_v2_contract_roundtrip_and_rejects_mixed_v1(registry):
    assets = _assets.fetch_stt_assets(MOONSHINE_V2)
    assert _assets.SttModelAssets.from_dict(assets.to_dict()) == assets
    registry.entries[MOONSHINE_V2]['cached_decoder'] = registry.entries[MOONSHINE_V2]['merged_decoder']
    with patch('wfloat._stt_assets.download_file') as network:
        with pytest.raises(ValueError, match='v1'):
            wfloat.load_stt_model(MOONSHINE_V2, cache_dir=registry.root)
        network.assert_not_called()


def test_core_rejects_unverified_hotword_scores():
    native = object.__new__(_core.CoreStt)
    native._config_bytes = {'model_id': FRENCH.encode()}
    with pytest.raises(ValueError, match='BPE scores'):
        native.configure_hotwords(['bonjour'])


def test_native_moonshine_config_without_inference(tmp_path):
    compiler = shutil.which('clang++') or shutil.which('g++')
    repo = Path(__file__).resolve().parents[3]
    if not compiler or sys.platform not in ('darwin', 'linux') or not (repo / 'vendor/sherpa-onnx').is_dir():
        pytest.skip('needs a C++ compiler and vendored headers in a source checkout')
    binary = tmp_path / 'stt-config'
    subprocess.run([compiler, '-std=c++17', '-ffunction-sections', '-fdata-sections',
                    '-Wl,-dead_strip' if sys.platform == 'darwin' else '-Wl,--gc-sections',
                    '-I', str(repo / 'native/wfloat-core/include'),
                    '-I', str(repo / 'native/wfloat-core/src'),
                    '-I', str(repo / 'vendor/sherpa-onnx'),
                    str(Path(__file__).with_name('stt_config_contract.cc')), '-o', str(binary)], check=True, capture_output=True)
    subprocess.run([str(binary)], check=True, capture_output=True)

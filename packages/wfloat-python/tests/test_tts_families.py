"""No model downloads or inference: exercise the generic core ABI contract."""
import ctypes as c
import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch
import warnings

import numpy as np
import pytest

from wfloat import _core, _tts_families as tts
from wfloat._model import Model
from wfloat._speech import TextToSpeechModel, load_text_to_speech
from wfloat import OperationCancelledError


def piper_config(model_id):
    speakers, voice = tts.PIPER[model_id]
    return dict(audio={'sample_rate': 22050}, num_speakers=speakers,
                espeak={'voice': voice}, phoneme_type='espeak',
                speaker_id_map={'last': speakers - 1},
                inference={'noise_scale': .667, 'noise_w': .8, 'length_scale': 1})


class Core:
    def __init__(self, rate=24000, speakers=54):
        self.rate, self.speakers = rate, speakers
        self.events = []
        self.fail_create = self.fail_synth = False
        self.pcm = (c.c_float * 2)(.25, .5)
        self.result = _core._WfloatTtsSynthesisResult(audio=_core._WfloatAudioResult(self.pcm, 2, rate, 0))

    def wfloat_tts_model_create(self, config, out):
        config = c.cast(config, c.POINTER(_core._WfloatTtsModelConfig)).contents
        # Mirror the native range check: ctypes silently zeroes omitted fields.
        assert .01 <= config.silence_scale <= 10
        assert config.silence_scale == 1
        assert config.num_threads == 1 and config.provider == b'cpu'
        assert config.max_num_sentences == 1 and config.length_scale > 0
        if config.family == 6:
            assert config.voices_path == str(Path('/staged') / 'model_voices').encode()
            assert not config.lexicon_path and not config.lang and not config.rule_fsts and not config.rule_fars
        self.events.append(('create', config.family, config.rule_fsts, config.lexicon_path,
                            config.noise_scale, config.noise_scale_w, config.max_num_sentences))
        c.cast(out, c.POINTER(c.c_void_p))[0] = c.c_void_p(1)
        return 3 if self.fail_create else 0

    def wfloat_tts_model_get_info(self, model, out):
        info = c.cast(out, c.POINTER(_core._WfloatTtsModelInfo)).contents
        info.sample_rate, info.num_speakers = self.rate, self.speakers
        return 0

    def wfloat_tts_model_destroy(self, model):
        self.events.append(('destroy',))

    def wfloat_tts_model_synthesize(self, model, options, callback, ctx, out):
        opts = c.cast(options, c.POINTER(_core._WfloatTtsSynthesizeOptions)).contents
        extra = {opts.extra_entries[i].key: opts.extra_entries[i].value for i in range(opts.extra_entry_count)}
        self.events.append(('synth', opts.text.decode(), opts.sid, opts.speed, extra))
        self.pcm[0] = .25
        c.cast(out, c.POINTER(c.POINTER(_core._WfloatTtsSynthesisResult)))[0] = c.pointer(self.result)
        return 3 if self.fail_synth else 0

    def wfloat_tts_synthesis_result_destroy(self, result):
        self.events.append(('free',))
        self.pcm[0] = -1


def native(core, model_id=tts.KOKORO, config_path=None):
    paths = {key: Path('/staged') / key for key in ('model_onnx', 'model_tokens', 'model_voices',
             'lexicon_zh', 'rule_date_zh', 'rule_number_zh', 'rule_phone_zh')}
    paths['model_config'] = config_path
    with patch.object(_core, '_load_core_library', return_value=core), \
         patch.object(_core, '_prepare_library', side_effect=lambda lib: lib):
        return tts.StandardTts(model_id, paths, Path('/espeak-ng-data'))


@pytest.mark.parametrize('model_id', tts.PIPER)
def test_piper_variants(tmp_path, model_id):
    config = tmp_path / 'model.json'
    data = piper_config(model_id)
    if model_id == 'rhasspy/piper-en_US-libritts-high':
        del data['phoneme_type']  # matches the pinned staged artifact
    config.write_text(json.dumps(data))
    core = Core(22050, tts.PIPER[model_id][0])
    adapter = native(core, model_id, config)
    with TextToSpeechModel(Model(model_id, adapter)) as model:
        model.generate('Hallo café!', voice_id='last', speed=1.25)
        call = next(e for e in core.events if e[0] == 'synth')
        assert call[1:] == ('Hallo café!', core.speakers - 1, 1.25, {})
        assert core.events[0][1] == 2
        assert core.events[0][4:6] == pytest.approx((.667, .8))
        for bad in (True, -1, core.speakers, 'af_heart', 1.5):
            with pytest.raises(ValueError):
                model.generate_stream('x', voice_id=bad)


@pytest.mark.parametrize('mutation', [lambda d: d.update(num_speakers=3),
    lambda d: d['espeak'].update(voice='wrong'), lambda d: d.update(speaker_id_map={'x': True}),
    lambda d: d['inference'].update(noise_w=float('nan')),
    lambda d: d['inference'].update(length_scale=0)])
def test_invalid_piper_metadata(tmp_path, mutation):
    model_id = next(iter(tts.PIPER))
    data = piper_config(model_id)
    mutation(data)
    path = tmp_path / 'config.json'
    path.write_text(json.dumps(data))
    with pytest.raises((ValueError, TypeError)):
        tts.configuration(model_id, path)


def test_all_kokoro_voice_routes_and_japanese_gate():
    core = Core()
    with TextToSpeechModel(Model(tts.KOKORO, native(core))) as model:
        for sid, alias in enumerate(tts.KOKORO_VOICES):
            if alias.startswith('j'):
                for voice in (sid, alias):
                    with pytest.raises(ValueError, match='Japanese frontend'):
                        model.generate_stream('漢字', voice_id=voice)
            else:
                model.generate('Bonjour 123!', voice_id=alias)
                call = [e for e in core.events if e[0] == 'synth'][-1]
                # Check the actual ABI language independently of the routing helper.
                expected = {'a': b'en-us', 'b': b'en', 'e': b'es', 'f': b'fr',
                            'h': b'hi', 'i': b'it', 'p': b'pt', 'z': b'en-us'}[alias[0]]
                assert call[2] == sid
                assert call[4] == {b'lang': expected}
        creates = [e for e in core.events if e[0] == 'create']
        assert len(creates) == 3  # non-Chinese -> Chinese -> em_santa
        assert creates[0][2] == creates[-1][2] == b''
        assert creates[1][2] == ','.join(str(Path('/staged') / key) for key in
            ('rule_date_zh', 'rule_number_zh', 'rule_phone_zh')).encode()
        assert all(e[3] == str(Path('/staged') / 'lexicon_zh').encode() for e in creates)
    for i, event in enumerate(core.events):
        if event[0] == 'create' and i:
            assert core.events[i - 1] == ('destroy',)


def test_session_failure_retry_and_no_reopen_after_unload():
    core = Core()
    adapter = native(core)
    core.fail_create = True
    with pytest.raises(RuntimeError, match='creation'):
        adapter.generate('你好', 45, 1)
    assert not adapter._model.value
    core.fail_create = False
    adapter.generate('hello', 0, 1)
    adapter.close()
    with pytest.raises(RuntimeError, match='unloaded'):
        adapter.generate('你好', 45, 1)


def test_owned_audio_error_cleanup_and_metadata():
    core = Core()
    adapter = native(core)
    audio = adapter.generate('hello', 0, 1)
    assert audio.samples[0] == .25
    core.fail_synth = True
    with pytest.raises(RuntimeError, match='status 3'):
        adapter.generate('hello', 0, 1)
    assert core.events[-1] == ('free',)
    core.fail_synth = False
    core.pcm[1] = float('nan')
    with pytest.raises(RuntimeError, match='invalid TTS audio'):
        adapter.generate('hello', 0, 1)
    assert core.events[-1] == ('free',)
    adapter.close()
    bad = Core(speakers=53)
    with pytest.raises(RuntimeError, match='metadata'):
        native(bad)
    assert bad.events[-1] == ('destroy',)


def test_public_stream_alignment_cancel_validation_and_warnings():
    core = Core()
    with TextToSpeechModel(Model(tts.KOKORO, native(core))) as model:
        text = '  café 中文 👩‍💻! ' * 60
        stream = model.generate_stream(text)
        assert not any(e[0] == 'synth' for e in core.events)
        chunks = list(stream)
        assert ''.join(chunk.timeline[0].text for chunk in chunks) == text
        for chunk in chunks:
            timing = chunk.timeline[0]
            assert text[timing.text_start:timing.text_end] == timing.text
        assert all(len(e[1]) <= 200 for e in core.events if e[0] == 'synth')
        cancel = Event()
        stream = model.generate_stream(text, cancel_event=cancel)
        next(stream)
        cancel.set()
        with pytest.raises(OperationCancelledError):
            next(stream)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            model.generate_dialogue([{'text': 'a', 'emotion': 'neutral'}, {'text': 'b', 'intensity': .2}], emotion='neutral')
        assert len(caught) == 2
        for options in ({'reference_audio': np.ones(10)}, {'speed': 1e-100}, {'voice_id': 54}, {'seed': -1}):
            with pytest.raises((TypeError, ValueError)):
                model.generate_stream('x', **options)


@pytest.mark.parametrize('model_id', tts.KITTEN)
def test_kitten_aliases_raw_text_and_native_owned_audio(model_id):
    core = Core(speakers=8)
    raw = "  Dr. Smith can't pay $12.50 at https://example.com/a?b=1. " * 12 + " Café 👩‍💻!  "
    with TextToSpeechModel(Model(model_id, native(core, model_id))) as model:
        assert core.events[0][1] == 6
        named = ('Jasper', 'Bella', 'Bruno', 'Luna', 'Hugo', 'Rosie', 'Leo', 'Kiki')
        exports = ('expr-voice-2-m', 'expr-voice-2-f', 'expr-voice-3-m', 'expr-voice-3-f',
                   'expr-voice-4-m', 'expr-voice-4-f', 'expr-voice-5-m', 'expr-voice-5-f')
        for sid, (name, export) in enumerate(zip(named, exports)):
            for voice in (name, export, sid):
                result = model.generate(raw, voice_id=voice, speed=1.25)
                call = [e for e in core.events if e[0] == 'synth'][-1]
                assert call[1:] == (raw, sid, 1.25, {})  # No frontend or speed-prior work in Python.
                assert len(result.timeline) == 1
                assert (result.timeline[0].text, result.timeline[0].text_start,
                        result.timeline[0].text_end) == (raw, 0, len(raw))
                # Already-trimmed native output must not lose another 5000 samples.
                np.testing.assert_array_equal(result.audio.samples, [.25, .5])
        model.generate('Hello.')
        assert [e for e in core.events if e[0] == 'synth'][-1][2:4] == (0, 1)
        assert len([e for e in core.events if e[0] == 'synth']) == 25
        for voice in (True, -1, 8, 'jasper', 'af_heart', '8', 1.5):
            with pytest.raises(ValueError):
                model.generate_stream(raw, voice_id=voice)


@pytest.mark.parametrize('model_id', tts.KITTEN)
def test_kitten_raw_unit_limit_dialogue_snapshot_and_controls(model_id):
    core = Core(speakers=8)
    with TextToSpeechModel(Model(model_id, native(core, model_id))) as model:
        # Python codepoint counts, not UTF-8 byte or UTF-16 unit counts.
        model.generate('😀' * 65536)
        count = len([e for e in core.events if e[0] == 'synth'])
        for text in ('x' * 65537, '😀' * 65537, ' ', 'a\0b'):
            with pytest.raises(ValueError):
                model.generate_dialogue_stream([{'text': 'valid'}, {'text': text}])
        assert len([e for e in core.events if e[0] == 'synth']) == count
        source = [{'text': "Price $12.50. Don't split!", 'voice_id': 'Hugo'},
                  {'text': '  Next sentence.  ', 'voice_id': 'Kiki'}]
        cancel = Event()
        stream = model.generate_dialogue_stream(source, cancel_event=cancel)
        source[0]['text'] = 'mutated'
        chunk = next(stream)
        assert chunk.timeline[0].text == "Price $12.50. Don't split!"
        assert [e for e in core.events if e[0] == 'synth'][-1][2:4] == (4, 1)
        cancel.set()
        with pytest.raises(OperationCancelledError):
            next(stream)
        assert len([e for e in core.events if e[0] == 'synth']) == count + 1
        for options in ({'reference_audio': np.ones(10)}, {'sample_rate': 24000},
                        {'speed': 1e-100}, {'speed': float('inf')}):
            with pytest.raises((TypeError, ValueError)):
                model.generate_stream('Hello.', **options)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            model.generate('Hello.', emotion='neutral', intensity=.5, temperature=.7, seed=0, inference_steps=1)
        assert len(caught) == 5


@pytest.mark.parametrize('model_id', tts.KITTEN)
def test_kitten_loader_dispatch_assets_and_family_validation(tmp_path, model_id):
    lease = SimpleNamespace(release=lambda: None)
    adapter = SimpleNamespace(family='kitten', sample_rate=24000, num_speakers=8,
                              voice_id=lambda value: 0, close=lambda: None)
    with patch('wfloat._speech.load_with_lifecycle', side_effect=lambda name, initialize, **kw: initialize(lease)), \
         patch.object(tts, 'load_cached', return_value=Model(model_id, adapter)) as cached:
        load_text_to_speech(model_id, cache_dir=tmp_path).unload()
        cached.assert_called_once_with(model_id, tmp_path)
    roles = ('model_onnx', 'model_tokens', 'model_voices')
    # Paths come from registry metadata; no public or private quantization option.
    entry = dict(family='kitten', **{key: {'path': '/models/x/immutable-selection/' + key} for key in roles})
    directory = tmp_path / 'models' / tts.normalize_model_name(model_id)
    directory.mkdir(parents=True)
    for key in roles:
        (directory / key).touch()
    data = tmp_path / 'espeak' / tts.SHARED_ASSETS['espeak_ng_data_zip']['sha256']
    (data / 'espeak-ng-data').mkdir(parents=True)
    (data / '.ready').touch()
    with patch.dict(tts.MODEL_ASSETS, {model_id: entry}), patch.object(tts, 'StandardTts', return_value=adapter) as create:
        tts.load_cached(model_id, tmp_path)
        assert create.call_args.args == (model_id, {key: directory / key for key in roles}, data / 'espeak-ng-data')
        entry['family'] = 'kokoro'
        with pytest.raises(ValueError, match='family must be kitten'):
            tts.load_cached(model_id, tmp_path)


def test_loader_dispatch_and_cached_paths(tmp_path):
    model_id = next(iter(tts.PIPER))
    lease = SimpleNamespace(release=lambda: None)
    adapter = SimpleNamespace(family='piper', sample_rate=22050, num_speakers=1,
                              voice_id=lambda value: 0, close=lambda: None)
    with patch('wfloat._speech.load_with_lifecycle', side_effect=lambda name, initialize, **kw: initialize(lease)), \
         patch.object(tts, 'load_cached', return_value=Model(model_id, adapter)) as cached:
        load_text_to_speech(model_id, cache_dir=tmp_path).unload()
        cached.assert_called_once_with(model_id, tmp_path)
    entry = dict(family='piper', **{key: {'path': '/models/x/fp32/' + key} for key in
                                 ('model_onnx', 'model_tokens', 'model_config')})
    directory = tmp_path / 'models' / tts.normalize_model_name(model_id)
    directory.mkdir(parents=True)
    for key in ('model_onnx', 'model_tokens', 'model_config'):
        (directory / key).touch()
    with patch.dict(tts.MODEL_ASSETS, {model_id: entry}), patch.object(tts, 'StandardTts', return_value=adapter) as create:
        with pytest.raises(FileNotFoundError, match='lifecycle-installed'):
            tts.load_cached(model_id, tmp_path)
        data = tmp_path / 'espeak' / tts.SHARED_ASSETS['espeak_ng_data_zip']['sha256']
        (data / 'espeak-ng-data').mkdir(parents=True)
        (data / '.ready').touch()
        tts.load_cached(model_id, tmp_path)
        assert create.call_args.args[2] == data / 'espeak-ng-data'
        assert create.call_args.args[1]['model_onnx'] == directory / 'model_onnx'


def test_core_kitten_silence_propagation_without_inference(tmp_path):
    import shutil
    import subprocess
    import sys
    compiler = shutil.which('clang++') or shutil.which('g++')
    repo = Path(__file__).resolve().parents[3]
    if not compiler or sys.platform not in ('darwin', 'linux') or not (repo / 'vendor/sherpa-onnx').is_dir():
        pytest.skip('needs a C++ compiler and vendored headers in a source checkout')
    binary = tmp_path / 'tts-config'
    subprocess.run([compiler, '-std=c++17', '-ffunction-sections', '-fdata-sections',
                    '-Wl,-dead_strip' if sys.platform == 'darwin' else '-Wl,--gc-sections',
                    '-I', str(repo / 'native/wfloat-core/include'),
                    '-I', str(repo / 'native/wfloat-core/src'),
                    '-I', str(repo / 'vendor/sherpa-onnx'),
                    str(Path(__file__).with_name('tts_config_contract.cc')), '-o', str(binary)],
                   check=True, capture_output=True)
    subprocess.run([str(binary)], check=True, capture_output=True)

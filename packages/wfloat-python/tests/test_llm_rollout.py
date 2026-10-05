"""Small transport fixtures; no model weights or native inference required."""
import hashlib
import io
from unittest.mock import patch

import pytest
import wfloat
from wfloat import _assets, _language_load, _lifecycle
from wfloat._llm_assets import fetch_llm_assets
from wfloat._language import LanguageModel
from test_language_surface import Backend, MESSAGES, done

MODELS = [('Qwen/Qwen3-0.6B', 'qwen3', 1), ('Qwen/Qwen3-1.7B', 'qwen3', 3),
          ('Qwen/Qwen3-4B', 'qwen3', 6), ('google/gemma-3-270m-it', 'gemma3', 1)]


@pytest.mark.parametrize('model_id,family,count', MODELS)
@pytest.mark.parametrize('failure', [None, 'corrupt', 'absent'])
def test_public_load_rollout_assets(monkeypatch, tmp_path, model_id, family, count, failure):
    data, payloads = {'family': family}, {}
    filenames = [('model' if count == 1 else f'model_shard_{i:05d}',
                  'model.gguf' if count == 1 else f'model-{i:05d}-of-{count:05d}.gguf')
                 for i in range(1, count + 1)]
    filenames += [('model_notice', 'NOTICE.txt'), ('model_provenance', 'provenance.json')]
    filenames += ([('model_license', 'LICENSE')] if family == 'qwen3' else
                  [('model_terms', 'terms.html'), ('model_policy', 'policy.html')])
    for role, name in filenames:
        path = '/models/test/' + name
        payload = role.encode()
        data[role] = {'path': path, 'sizeBytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}
        payloads[path] = payload
    monkeypatch.setattr(_assets, 'MODEL_ASSETS', {model_id: data})
    monkeypatch.setattr(_lifecycle, 'MODEL_ASSETS', {model_id: data})
    assets = fetch_llm_assets(model_id)
    assert assets.family == family and assets.context_size == 2048
    assert assets.chat_template is None and assets.chat_template_format is None
    assert len(assets.model_shards) == (count if count > 1 else 0)
    backends, requests = [], []
    def download(request, **kwargs):
        path = request.full_url.removeprefix(_assets.REGISTRY_ORIGIN)
        requests.append(path)
        payload = payloads[path]
        if path.endswith(filenames[count - 1][1]):
            if failure == 'absent':
                raise FileNotFoundError(path)
            if failure == 'corrupt':
                payload = b'x' * len(payload)
        response = io.BytesIO(payload)
        response.status, response.headers = 200, {'Content-Length': str(len(payload))}
        return response
    class Loaded(Backend):
        def __init__(self, path, **options):
            super().__init__([done()])
            backends.append(self)
            self.path, self.options = path, options
            self.context_size = options['context_size']
            assert path.name == filenames[0][1]
            assert all((path.parent / name).is_file() for _, name in filenames)
    with patch.object(_lifecycle, 'urlopen', side_effect=download), patch.object(_language_load, 'NativeLanguageBackend', Loaded):
        if failure:
            with pytest.raises((FileNotFoundError, IOError)):
                wfloat.load_language_model(model_id, cache_dir=tmp_path)
            assert not backends
            wfloat.delete_model_assets(model_id, cache_dir=tmp_path)
            return
        model = wfloat.load_language_model(model_id, cache_dir=tmp_path)
        assert backends[-1].options == {'context_size': 2048, 'num_threads': 4, 'chat_template': None}
        assert len(requests) == len(filenames)
        model.generate(MESSAGES, reasoning=False)
        assert backends[-1].requests[0].get('temperature') == (0.7 if family == 'qwen3' else None)
        with pytest.raises(wfloat.ModelAssetsInUseError):
            wfloat.delete_model_assets(model_id, cache_dir=tmp_path)
        model.unload()
        with patch.object(_lifecycle, 'urlopen', side_effect=AssertionError('network on reload')):
            model = wfloat.load_language_model(model_id, cache_dir=tmp_path, context_size=1024, chat_template='custom')
            assert backends[-1].options['context_size'] == 1024
            assert backends[-1].options['chat_template'] == 'custom'
            model.unload()
        wfloat.delete_model_assets(model_id, cache_dir=tmp_path)
        assert not backends[-1].path.exists()


@pytest.mark.parametrize('model_id', [m[0] for m in MODELS[:3]])
@pytest.mark.parametrize('reasoning', [None, True, False])
@pytest.mark.parametrize('streaming', [False, True])
def test_qwen_sampling(model_id, reasoning, streaming):
    backend = Backend([done()], [done()])
    model = LanguageModel(backend, model_id)
    def generate(**options):
        if streaming:
            with model.generate_stream(MESSAGES, **options) as stream:
                return stream.result()
        return model.generate(MESSAGES, **options)
    generate(reasoning=reasoning)
    request = backend.requests[-1]
    assert [request[k] for k in ('temperature', 'topP', 'topK', 'minP')] == (
        [0.7, 0.8, 20, 0] if reasoning is False else [0.6, 0.95, 20, 0])
    assert request.get('reasoning') == reasoning
    generate(reasoning=reasoning, temperature=0, top_p=0, top_k=0, min_p=0.2, seed=0)
    assert [backend.requests[-1][k] for k in ('temperature', 'topP', 'topK', 'minP', 'seed')] == [0, 0, 0, 0.2, 0]
    model.unload()


@pytest.mark.parametrize('model_id', ['google/gemma-3-270m-it', 'google/gemma-3-1b-it', 'HuggingFaceTB/SmolLM2-360M-Instruct'])
def test_other_models_keep_native_sampling(model_id):
    backend = Backend([done()])
    model = LanguageModel(backend, model_id)
    model.generate(MESSAGES)
    assert all(k not in backend.requests[0] for k in ('temperature', 'topP', 'topK', 'minP', 'reasoning'))
    model.unload()

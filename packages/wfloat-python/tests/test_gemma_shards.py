"""Native GGUF split ordering, registry validation and lifecycle integration."""
import copy
import hashlib
import io
import os
from pathlib import Path
from unittest.mock import patch

import pytest

import wfloat
from wfloat import _assets, _language_load, _lifecycle
from wfloat._llm_assets import cache_llm_model_assets

MODEL = 'google/gemma-3-1b-it'


@pytest.fixture
def registry(monkeypatch):
    # Reverse insertion order deliberately: native entrypoint must be shard 1.
    data = {'family': 'gemma3'}
    payloads = {}
    for role, filename in [
        ('model_shard_00002', 'model-00002-of-00002.gguf'),
        ('model_shard_00001', 'model-00001-of-00002.gguf'),
        ('model_terms', 'terms.html'), ('model_policy', 'policy.html'),
        ('model_notice', 'NOTICE.txt'), ('model_provenance', 'provenance.json'),
    ]:
        payload = role.encode()
        path = '/models/gemma/' + filename
        payloads[path] = payload
        data[role] = {'path': path, 'sha256': hashlib.sha256(payload).hexdigest(),
                      'sizeBytes': len(payload)}
    monkeypatch.setattr(_assets, 'MODEL_ASSETS', {MODEL: data})
    monkeypatch.setattr(_lifecycle, 'MODEL_ASSETS', {MODEL: data})
    return data, payloads


def split_assets(count, prefix='weights.Q4_K_M'):
    data, payloads = {}, {}
    for index in reversed(range(1, count + 1)):
        role = f'model_shard_{index:05d}'
        path = f'/models/test/{prefix}-{index:05d}-of-{count:05d}.gguf'
        payload = role.encode()
        data[role] = {'path': path, 'sha256': hashlib.sha256(payload).hexdigest(),
                      'sizeBytes': len(payload)}
        payloads[path] = payload
    return data, payloads


@pytest.mark.parametrize('count', [3, 12])
@pytest.mark.parametrize('model_id', [MODEL, _assets.SMOLLM2_360M_INSTRUCT_MODEL_ID])
def test_generic_split_fetch_cache_and_lifecycle(registry, monkeypatch, tmp_path, count, model_id):
    data, payloads = split_assets(count)
    if model_id == MODEL:
        data.update({key: value for key, value in registry[0].items()
                     if not key.startswith('model_shard_')})
    else:
        data['family'] = 'smollm'
    monkeypatch.setattr(_assets, 'MODEL_ASSETS', {model_id: data})
    monkeypatch.setattr(_lifecycle, 'MODEL_ASSETS', {model_id: data})
    assets = _assets.fetch_llm_assets(model_id)
    names = [f'weights.Q4_K_M-{index:05d}-of-{count:05d}.gguf' for index in range(1, count + 1)]
    assert [Path(url).name for url in assets.model_shards] == names
    assert assets.model == assets.model_shards[0]
    assert assets.context_size == (2048 if model_id == MODEL else 8192)
    assert assets.chat_template_format == (None if model_id == MODEL else 'chatml')
    lifecycle_paths = {asset.path for asset in _lifecycle._assets(model_id, tmp_path)}
    downloads = []
    def download(url, destination, **kwargs):
        downloads.append(url)
        destination.write_bytes(payloads[url.removeprefix(_assets.REGISTRY_ORIGIN)])
    with patch('wfloat._llm_assets.download_file', side_effect=download):
        cached = cache_llm_model_assets(model_id, assets, cache_dir=tmp_path)
        assert [cached.require(f'model_shard_{index:05d}').name for index in range(1, count + 1)] == names
        assert set(cached.files.values()) <= lifecycle_paths
        assert cached.require('model').name == names[0]
        assert downloads == list(assets.model_shards)
        cache_llm_model_assets(model_id, assets, cache_dir=tmp_path)
        assert len(downloads) == count


@pytest.mark.parametrize('fault', ['empty', 'one', 'gap', 'zero', 'unpadded', 'malformed',
                                  'prefix', 'count'])
def test_generic_split_rejects_incomplete_or_inconsistent_roles(monkeypatch, tmp_path, fault):
    data, _ = split_assets(3)
    if fault == 'empty':
        data.clear()
    elif fault == 'one':
        data, _ = split_assets(1)
    elif fault == 'gap':
        del data['model_shard_00002']
    elif fault in ('zero', 'unpadded', 'malformed'):
        replacement = {'zero': 'model_shard_00000', 'unpadded': 'model_shard_1',
                       'malformed': 'model_shard_abcde'}[fault]
        data[replacement] = data.pop('model_shard_00001')
    elif fault == 'prefix':
        data['model_shard_00002']['path'] = '/models/test/other-00002-of-00003.gguf'
    else:
        data['model_shard_00003']['path'] = '/models/test/weights.Q4_K_M-00003-of-00004.gguf'
    with pytest.raises(ValueError):
        _assets._llm_shard_assets(data)
    # Generic lifecycle validation must reject broken splits for other model IDs too.
    if data:
        monkeypatch.setattr(_lifecycle, 'MODEL_ASSETS', {'other/llm': data})
        with patch.object(_lifecycle, 'urlopen') as network:
            with pytest.raises(ValueError):
                wfloat.download_model('other/llm', cache_dir=tmp_path)
            network.assert_not_called()


def test_order_and_defaults(registry):
    assets = _assets.fetch_llm_assets(MODEL)
    assert assets.family == 'gemma3'
    assert assets.context_size == 2048
    assert assets.chat_template is None and assets.chat_template_format is None
    assert assets.model == assets.model_shards[0]
    assert [Path(url).name for url in assets.model_shards] == [
        'model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']
    assert assets.model_checksum == assets.model_shard_checksums[0]


@pytest.mark.parametrize('role', ['model_shard_00001', 'model_shard_00002',
    'model_terms', 'model_policy', 'model_notice', 'model_provenance'])
def test_missing_manifest_asset_rejected_before_download(registry, role, tmp_path):
    del registry[0][role]
    with patch.object(_lifecycle, 'urlopen') as network:
        with pytest.raises((ValueError, RuntimeError)):
            _assets.fetch_llm_assets(MODEL)
        with pytest.raises((ValueError, RuntimeError)):
            wfloat.download_model(MODEL, cache_dir=tmp_path)
        network.assert_not_called()


@pytest.mark.parametrize('fault', ['swapped', 'different_parent', 'bad_count', 'extra', 'single', 'family'])
def test_invalid_shard_manifest(registry, fault):
    data = registry[0]
    first, second = data['model_shard_00001'], data['model_shard_00002']
    if fault == 'swapped':
        first['path'], second['path'] = second['path'], first['path']
    elif fault == 'different_parent':
        second['path'] = second['path'].replace('/gemma/', '/other/')
    elif fault == 'bad_count':
        first['path'] = first['path'].replace('of-00002', 'of-00003')
    elif fault == 'extra':
        data['model_shard_00003'] = copy.deepcopy(second)
    elif fault == 'single':
        data['model'] = copy.deepcopy(first)
    else:
        data['family'] = 'smollm'
    with pytest.raises(ValueError):
        _assets.fetch_llm_assets(MODEL)


def test_cache_materializes_both_canonical_siblings_and_reuses(registry, tmp_path):
    assets = _assets.fetch_llm_assets(MODEL)
    seen = []
    def download(url, destination, **kwargs):
        seen.append(url)
        destination.write_bytes(registry[1][url.removeprefix(_assets.REGISTRY_ORIGIN)])
    with patch('wfloat._llm_assets.download_file', side_effect=download):
        cached = cache_llm_model_assets(MODEL, assets, cache_dir=tmp_path)
        assert len(seen) == 2
        assert cached.require('model') == cached.require('model_shard_00001')
        assert cached.require('model').parent == cached.require('model_shard_00002').parent
        cache_llm_model_assets(MODEL, assets, cache_dir=tmp_path)
        assert len(seen) == 2
        cached.require('model_shard_00002').unlink()
        cache_llm_model_assets(MODEL, assets, cache_dir=tmp_path)
        assert seen == [*assets.model_shards, assets.model_shards[1]]


@pytest.mark.parametrize('failure', [None, 'absent', 'corrupt'])
def test_public_load_downloads_all_assets_before_backend_and_reloads(registry, tmp_path, failure):
    requests, backends = [], []
    def open_asset(request, **kwargs):
        path = request.full_url.removeprefix(_assets.REGISTRY_ORIGIN)
        requests.append(path)
        if failure == 'absent' and path.endswith('00002.gguf'):
            raise FileNotFoundError(path)
        payload = registry[1][path]
        if failure == 'corrupt' and path.endswith('00002.gguf'):
            payload = b'x' * len(payload)
        response = io.BytesIO(payload)
        response.status, response.headers = 200, {'Content-Length': str(len(payload))}
        return response
    class Backend:
        def __init__(self, path, **options):
            backends.append(self)
            self.path, self.options, self.unloaded = path, options, False
            self.context_size = options['context_size']
            assert path.name == 'model-00001-of-00002.gguf'
            assert (path.parent / 'model-00002-of-00002.gguf').is_file()
            assert len(list(path.parent.iterdir())) == 6
        def unload(self):
            self.unloaded = True
    with patch.object(_lifecycle, 'urlopen', side_effect=open_asset), \
            patch.object(_language_load, 'NativeLanguageBackend', Backend):
        if failure:
            with pytest.raises((FileNotFoundError, IOError)):
                wfloat.load_language_model(MODEL, cache_dir=tmp_path)
            assert not backends
            # A failed load must release ownership and permit deletion/retry.
            wfloat.delete_model_assets(MODEL, cache_dir=tmp_path)
            return
        model = wfloat.load_language_model(MODEL, cache_dir=tmp_path)
        assert len(requests) == 6
        assert backends[0].options == {'context_size': 2048, 'num_threads': 4, 'chat_template': None}
        with pytest.raises(wfloat.ModelAssetsInUseError):
            wfloat.delete_model_assets(MODEL, cache_dir=tmp_path)
        model.unload()
        assert backends[0].unloaded
        with patch.object(_lifecycle, 'urlopen', side_effect=AssertionError('cached reload used network')):
            model = wfloat.load_language_model(MODEL, cache_dir=tmp_path, context_size=1024, chat_template='custom')
            assert backends[-1].options['context_size'] == 1024
            assert backends[-1].options['chat_template'] == 'custom'
            model.unload()
        wfloat.delete_model_assets(MODEL, cache_dir=tmp_path)
        assert not backends[-1].path.exists()


@pytest.mark.skipif(not os.environ.get('WFLOAT_TEST_GEMMA_CACHE'),
                    reason='set WFLOAT_TEST_GEMMA_CACHE and WFLOAT_LLM_LIBRARY for public Gemma smoke')
def test_public_endpoint_native_generation_cached_reload():
    cache = Path(os.environ['WFLOAT_TEST_GEMMA_CACHE'])
    messages = [{'role': 'user', 'content': 'What is the capital of France? Answer briefly.'}]
    for cached in (False, True):
        guard = (patch.object(_lifecycle, 'urlopen', side_effect=AssertionError('cached reload used network'))
                 if cached else patch.object(_lifecycle, 'urlopen', wraps=_lifecycle.urlopen))
        with guard, patch('wfloat._llm_assets.download_file',
                          side_effect=AssertionError('loader bypassed lifecycle download')):
            model = wfloat.load_language_model(MODEL, cache_dir=cache)
            try:
                result = model.generate(messages, max_tokens_per_round=32, temperature=0)
                assert result.text.strip() and result.usage.output_tokens > 0
                assert 'paris' in result.text.lower()
                print(f'Gemma cached={cached}: {result.text!r}; usage={result.usage}')
                with pytest.raises(wfloat.ModelAssetsInUseError):
                    wfloat.delete_model_assets(MODEL, cache_dir=cache)
            finally:
                model.unload()
            # Confirms unload releases its lifecycle lease without deleting cache.
            with _lifecycle._file_access(cache, _lifecycle._model_lock_name(MODEL)):
                assert _lifecycle._assets_ready(MODEL, cache)

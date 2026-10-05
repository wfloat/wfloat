import { standardModel, standardConfig } from './families.js';
import { acquireModelAssetLease, downloadModel } from '../assets/index.js';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types.js';
import { readAsset } from '../assets/store.js';
import { SHERPA_WASM_URL } from '../runtime/urls.js';
import { MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS } from '../worker/generatedModelUrls.js';
import { SherpaTextToSpeechBackend } from './backend.js';
import { TextToSpeechModel } from './model.js';

export type LoadTextToSpeechOptions = DownloadModelOptions;
export async function loadTextToSpeech(id: string, options: LoadTextToSpeechOptions = {}): Promise<TextToSpeechModel> {
  const standard = standardModel(id);
  if (!standard && id !== 'wfloat/wfloat-tts' && id !== 'kyutai/pocket-tts') throw new Error(`Unsupported TTS model: ${id}`);
  const lease = await acquireModelAssetLease(id, { signal: options.signal });
  let backend: SherpaTextToSpeechBackend | undefined;
  const abort = () => { void backend?.unload(); };
  lease.signal.addEventListener('abort', abort, { once: true });
  try {
    await downloadModel(id, { signal: lease.signal, persistence: options.persistence, onProgress: event => {
      if (event.phase !== 'ready') notify(options.onProgress, event);
    } });
    checkAbort(lease.signal);
    notify(options.onProgress, { phase: 'loading' });
    const read = (url: string) => readAsset(url, { signal: lease.signal });
    const wasm = await read(SHERPA_WASM_URL);
    let workerAssets: import('./backend.js').WorkerAssets;
    if (id === 'kyutai/pocket-tts') {
      const files: Record<string, Uint8Array> = {};
      for (const [name, asset] of Object.entries(MODEL_ASSETS[id])) {
        if (typeof asset === 'object') files[name] = await read(REGISTRY_ORIGIN + asset.path);
      }
      workerAssets = { family: 'pocket', wasm, files };
    } else if (standard) {
      // The parent owns registry generation and shared-dependency registration.
      const record = (MODEL_ASSETS as Record<string, Record<string, unknown>>)[id];
      const required = standard.family === 'piper' ? ['model_onnx', 'model_tokens', 'model_config'] :
        standard.family === 'kitten' ? ['model_onnx', 'model_tokens', 'model_voices'] :
        ['model_onnx', 'model_tokens', 'model_voices', 'lexicon_zh', 'rule_date_zh', 'rule_number_zh', 'rule_phone_zh'];
      const files: Record<string, Uint8Array> = {};
      for (const key of required) {
        const asset = record?.[key];
        if (!asset || typeof asset !== 'object' || !('path' in asset) || typeof asset.path !== 'string') throw new Error(`Missing TTS asset ${id}/${key}`);
        files[key] = await read(REGISTRY_ORIGIN + asset.path);
      }
      const config = standardConfig(id, files.model_config);
      const espeak = await read(REGISTRY_ORIGIN + SHARED_ASSETS.espeak_ng_data_zip.path);
      workerAssets = { family: config.family, config, wasm, files, espeak };
    } else {
      const assets = MODEL_ASSETS['wfloat/wfloat-tts'];
      const model = await read(REGISTRY_ORIGIN + assets.model_onnx.path);
      const tokens = await read(REGISTRY_ORIGIN + assets.model_tokens.path);
      const espeak = await read(REGISTRY_ORIGIN + SHARED_ASSETS.espeak_ng_data_zip.path);
      workerAssets = { wasm, model, tokens, espeak };
    }
    checkAbort(lease.signal);
    backend = new SherpaTextToSpeechBackend(new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' }));
    await backend.initialize(workerAssets);
    await lease.assertCurrent();
    checkAbort(lease.signal);
    const result = new TextToSpeechModel(backend);
    // Detach before ready callbacks: caller abort after readiness cannot unload the model.
    lease.signal.removeEventListener('abort', abort);
    lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return result;
  } catch (error) {
    await backend?.unload();
    checkAbort(lease.signal);
    throw error;
  } finally {
    lease.signal.removeEventListener('abort', abort);
    lease.release();
  }
}

import { acquireModelAssetLease, downloadModel } from '../assets/index.js';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types.js';
import { readAsset } from '../assets/store.js';
import { SHERPA_WASM_URL } from '../runtime/urls.js';
import { MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS } from '../worker/generatedModelUrls.js';
import { SherpaTextToSpeechBackend } from './backend.js';
import { TextToSpeechModel } from './model.js';

export type LoadTextToSpeechOptions = DownloadModelOptions;
export async function loadTextToSpeech(id: string, options: LoadTextToSpeechOptions = {}): Promise<TextToSpeechModel> {
  if (id !== 'wfloat/wfloat-tts') throw new Error(`Unsupported TTS model: ${id}`);
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
    const assets = MODEL_ASSETS['wfloat/wfloat-tts'];
    const read = (url: string) => readAsset(url, { signal: lease.signal });
    // Sequential reads avoid unbounded parallel disk buffers on low-memory devices.
    const wasm = await read(SHERPA_WASM_URL);
    const model = await read(REGISTRY_ORIGIN + assets.model_onnx.path);
    const tokens = await read(REGISTRY_ORIGIN + assets.model_tokens.path);
    const espeak = await read(REGISTRY_ORIGIN + SHARED_ASSETS.espeak_ng_data_zip.path);
    checkAbort(lease.signal);
    backend = new SherpaTextToSpeechBackend(new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' }));
    await backend.initialize({ wasm, model, tokens, espeak });
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

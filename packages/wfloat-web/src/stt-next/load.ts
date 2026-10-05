import { acquireModelAssetLease, downloadModel } from '../assets/index.js';
import { checkAbort, notify } from '../assets/types.js';
import { isComposite, readComposite } from '../assets/composite.js';
import { readAsset } from '../assets/store.js';
import { SHERPA_WASM_URL } from '../runtime/urls.js';
import { MODEL_ASSETS, REGISTRY_ORIGIN } from '../worker/generatedModelUrls.js';
import { SherpaSpeechToTextBackend, type WorkerAssets } from './backend.js';
import { sttCapabilities } from './capabilities.js';
import { SpeechToTextModel, StreamingSpeechToTextModel } from './model.js';
import type { LoadSpeechToTextOptions } from './types.js';

async function load(id: string, options: LoadSpeechToTextOptions, live: boolean) {
  sttCapabilities(id); // Fail unsupported IDs before downloading or allocating a worker.
  const lease = await acquireModelAssetLease(id, { signal: options.signal });
  let backend: SherpaSpeechToTextBackend | undefined;
  const abort = () => backend?.abortInitialization();
  lease.signal.addEventListener('abort', abort, { once: true });
  try {
    await downloadModel(id, { signal: lease.signal, persistence: options.persistence, onProgress: event => {
      if (event.phase !== 'ready') notify(options.onProgress, event);
    } });
    checkAbort(lease.signal);
    notify(options.onProgress, { phase: 'loading' });
    const assets = { wasm: await readAsset(SHERPA_WASM_URL, { signal: lease.signal }) } as WorkerAssets;
    const records = MODEL_ASSETS[id as keyof typeof MODEL_ASSETS];
    for (const [key, value] of Object.entries(records)) {
      if (isComposite(value)) {
        (assets as unknown as Record<string, Uint8Array>)[key] = await readComposite(value, lease.signal);
      } else if (typeof value === 'object' && 'path' in value && ['tokens', 'encoder', 'decoder', 'joiner', 'preprocessor', 'uncached_decoder', 'cached_decoder', 'merged_decoder'].includes(key)) {
        (assets as unknown as Record<string, Uint8Array>)[key] = await readAsset(REGISTRY_ORIGIN + value.path, { signal: lease.signal });
      }
    }
    checkAbort(lease.signal);
    backend = new SherpaSpeechToTextBackend(new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' }), id);
    await backend.initialize(assets);
    await lease.assertCurrent(); checkAbort(lease.signal);
    const model = live ? new StreamingSpeechToTextModel(backend) : new SpeechToTextModel(backend);
    lease.signal.removeEventListener('abort', abort); lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) {
    await backend?.unload(); checkAbort(lease.signal); throw error;
  } finally { lease.signal.removeEventListener('abort', abort); lease.release(); }
}
export function loadSpeechToText(id: string, options: LoadSpeechToTextOptions = {}): Promise<SpeechToTextModel> {
  return load(id, options, false) as Promise<SpeechToTextModel>;
}
export function loadStreamingSpeechToText(id: string, options: LoadSpeechToTextOptions = {}): Promise<StreamingSpeechToTextModel> {
  return load(id, options, true) as Promise<StreamingSpeechToTextModel>;
}

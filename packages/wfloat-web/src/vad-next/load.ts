import { acquireModelAssetLease, downloadModel } from '../assets/index.js';
import { checkAbort, notify } from '../assets/types.js';
import { readAsset } from '../assets/store.js';
import { SHERPA_WASM_URL } from '../runtime/urls.js';
import { MODEL_ASSETS, REGISTRY_ORIGIN } from '../worker/generatedModelUrls.js';
import { SherpaVadBackend, type WorkerAssets } from './backend.js';
import { validateVadModel } from './backend-types.js';
import { VoiceActivityDetectionModel } from './model.js';
import type { DownloadModelOptions } from '../assets/types.js';

export async function loadVoiceActivityDetection(id: string, options: DownloadModelOptions = {}): Promise<VoiceActivityDetectionModel> {
  validateVadModel(id); // Fail unsupported IDs before downloading or allocating a worker.
  const lease = await acquireModelAssetLease(id, { signal: options.signal });
  let backend: SherpaVadBackend | undefined;
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
      if (typeof value === 'object' && 'path' in value) {
        (assets as unknown as Record<string, Uint8Array>)[key] = await readAsset(REGISTRY_ORIGIN + value.path, { signal: lease.signal });
      }
    }
    checkAbort(lease.signal);
    backend = new SherpaVadBackend(new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' }), id);
    await backend.initialize(assets);
    await lease.assertCurrent(); checkAbort(lease.signal);
    const model = new VoiceActivityDetectionModel(backend);
    lease.signal.removeEventListener('abort', abort); lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) {
    try { await backend?.unload(); } catch { /* Preserve the original initialization failure. */ }
    checkAbort(lease.signal); throw error;
  } finally { lease.signal.removeEventListener('abort', abort); lease.release(); }
}

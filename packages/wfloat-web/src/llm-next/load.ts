import { acquireModelAssetLease, downloadModel, getModelRuntimeFamily } from '../assets/index.js';
import { getLanguageModelFiles } from './assets.js';
import { readAsset } from '../assets/store.js';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types.js';
import { LLAMA_WASM_URL } from '../runtime/urls.js';
import { createLanguageNativeBackend } from '../llm-native/bridge.js';
import { LanguageModel } from './model.js';

export interface LoadLanguageModelOptions extends DownloadModelOptions {
  contextSize?: number;
  numThreads?: number;
}

export async function loadLanguageModel(id: string, options: LoadLanguageModelOptions = {}): Promise<LanguageModel> {
  if (getModelRuntimeFamily(id) !== 'llama') throw new TypeError(`${id} is not a language model.`);
  const contextSize = options.contextSize ?? 2048;
  if (!Number.isSafeInteger(contextSize) || contextSize < 1) throw new TypeError('contextSize must be a positive integer.');
  if (options.numThreads !== undefined && options.numThreads !== 1) throw new TypeError('This web runtime is single-threaded; numThreads must be 1.');
  const files = getLanguageModelFiles(id);
  const lease = await acquireModelAssetLease(id, { signal: options.signal });
  let backend: Awaited<ReturnType<typeof createLanguageNativeBackend>> | undefined;
  try {
    await downloadModel(id, { ...options, signal: lease.signal, onProgress: event => { if (event.phase !== 'ready') notify(options.onProgress, event); } });
    notify(options.onProgress, { phase: 'loading' });
    const modelFiles: Array<{ name: string; data: ArrayBuffer }> = [];
    for (const file of files) {
      const bytes = await readAsset(file.url, { signal: lease.signal });
      modelFiles.push({ name: file.name, data: bytes.buffer as ArrayBuffer });
    }
    const wasmBinary = await readAsset(LLAMA_WASM_URL, { signal: lease.signal });
    checkAbort(lease.signal);
    backend = await createLanguageNativeBackend({ ...(modelFiles.length === 1 ? { model: modelFiles[0]!.data } : { modelFiles }), wasmBinary, wasmUrl: LLAMA_WASM_URL, contextSize, numThreads: options.numThreads, signal: lease.signal });
    await lease.assertCurrent();
    // Schema conversion and native preflight are prerequisites of each operation.
    const native = backend;
    const prepared = attachSchemas(native);
    await lease.assertCurrent();
    const loaded = new LanguageModel(prepared, id);
    lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return loaded;
  } catch (error) {
    await backend?.unload().catch(() => {});
    checkAbort(lease.signal);
    throw error;
  } finally { lease.release(); }
}

import { attachSchemas } from './schemas.js';

import { loadAssets } from '../assets/index';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types';
import { createLanguageNativeBackend } from '../llm-native/bridge';
import { LanguageModel } from './model';
import { attachSchemas } from './schemas';
export interface LoadLanguageModelOptions extends DownloadModelOptions { contextSize?: number; numThreads?: number }
export async function loadLanguageModel(id: string, options: LoadLanguageModelOptions = {}): Promise<LanguageModel> {
  const contextSize = options.contextSize ?? 2048;
  if (!Number.isSafeInteger(contextSize) || contextSize < 1) throw new TypeError('contextSize must be a positive integer.');
  if (options.numThreads !== undefined && (!Number.isSafeInteger(options.numThreads) || options.numThreads < 1)) throw new TypeError('numThreads must be a positive integer.');
  const lease = await loadAssets(id, 'llm', options);
  let backend: Awaited<ReturnType<typeof createLanguageNativeBackend>> | undefined;
  try {
    notify(options.onProgress, { phase: 'loading' });
    backend = await createLanguageNativeBackend({ modelId: id, paths: lease.paths, contextSize, numThreads: options.numThreads, signal: lease.signal });
    lease.assertCurrent(); checkAbort(lease.signal);
    const model = new LanguageModel(attachSchemas(backend), id);
    lease.release(); notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) { await backend?.unload().catch(() => {}); checkAbort(lease.signal); throw error; }
  finally { lease.release(); }
}

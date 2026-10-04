import { loadAssets } from '../assets/index';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types';
import { NativeInstance } from '../llm-native/instance';
import { NativeTextToSpeechBackend } from './backend';
import { TextToSpeechModel } from './model';
export type LoadTextToSpeechOptions = DownloadModelOptions;
export async function loadTextToSpeech(id: string, options: LoadTextToSpeechOptions = {}): Promise<TextToSpeechModel> {
  if (id !== 'wfloat/wfloat-tts') throw new Error(`Unsupported TTS model: ${id}`);
  const lease = await loadAssets(id, 'tts', options);
  const native = new NativeInstance();
  try {
    notify(options.onProgress, { phase: 'loading' });
    const loaded = await native.call<{ sampleRate: number }>('load', { task: 'tts', modelId: id, family: lease.family, paths: lease.paths, options: {} }, { signal: lease.signal });
    lease.assertCurrent(); checkAbort(lease.signal);
    const model = new TextToSpeechModel(new NativeTextToSpeechBackend(native, loaded.sampleRate));
    lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) { await native.unload().catch(() => {}); checkAbort(lease.signal); throw error; }
  finally { lease.release(); }
}

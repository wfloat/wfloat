import { standardModel, standardConfig } from './families';
import { loadAssets } from '../assets/index';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types';
import { NativeInstance } from '../llm-native/instance';
import { NativePocketTextToSpeechBackend, NativeStandardTextToSpeechBackend, NativeTextToSpeechBackend } from './backend';
import { TextToSpeechModel } from './model';
export type LoadTextToSpeechOptions = DownloadModelOptions;
export async function loadTextToSpeech(id: string, options: LoadTextToSpeechOptions = {}): Promise<TextToSpeechModel> {
  const standard = standardModel(id);
  if (!standard && id !== 'wfloat/wfloat-tts' && id !== 'kyutai/pocket-tts') throw new Error(`Unsupported TTS model: ${id}`);
  const lease = await loadAssets(id, 'tts', options);
  const native = new NativeInstance();
  try {
    notify(options.onProgress, { phase: 'loading' });
    const loaded = await native.call<{ sampleRate: number; numSpeakers?: number; metadata?: unknown }>('load', { task: 'tts', modelId: id, family: lease.family, paths: lease.paths, options: {} }, { signal: lease.signal });
    lease.assertCurrent(); checkAbort(lease.signal);
    const config = standard ? standardConfig(id, loaded.metadata) : undefined;
    if (config && (loaded.sampleRate !== config.sampleRate || loaded.numSpeakers !== config.numSpeakers)) throw new Error('TTS runtime metadata does not match selected model.');
    const model = new TextToSpeechModel(config ? new NativeStandardTextToSpeechBackend(native, config) : id === 'kyutai/pocket-tts' ? new NativePocketTextToSpeechBackend(native, loaded.sampleRate) : new NativeTextToSpeechBackend(native, loaded.sampleRate));
    lease.release();
    notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) { await native.unload().catch(() => {}); checkAbort(lease.signal); throw error; }
  finally { lease.release(); }
}

import { loadAssets } from '../assets/index';
import { checkAbort, notify } from '../assets/types';
import { NativeInstance } from '../llm-native/instance';
import { NativeSpeechToTextBackend } from './backend';
import { sttCapabilities } from './capabilities';
import { SpeechToTextModel, StreamingSpeechToTextModel } from './model';
import type { LoadSpeechToTextOptions } from './types';
async function load(id: string, options: LoadSpeechToTextOptions, live: boolean) {
  const capabilities = sttCapabilities(id);
  const lease = await loadAssets(id, 'stt', options);
  const native = new NativeInstance();
  try {
    notify(options.onProgress, { phase: 'loading' });
    const loaded = await native.call<{ kind: 'offline' | 'online' }>('load', { task: 'stt', modelId: id, family: lease.family, paths: lease.paths, options: {} }, { signal: lease.signal });
    if (loaded.kind !== capabilities.kind) throw new Error('Native recognizer kind does not match the model.');
    lease.assertCurrent(); checkAbort(lease.signal);
    const backend = new NativeSpeechToTextBackend(native, id);
    const model = live ? new StreamingSpeechToTextModel(backend) : new SpeechToTextModel(backend);
    lease.release(); notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) { await native.unload().catch(() => {}); checkAbort(lease.signal); throw error; }
  finally { lease.release(); }
}
export function loadSpeechToText(id: string, options: LoadSpeechToTextOptions = {}): Promise<SpeechToTextModel> { return load(id, options, false) as Promise<SpeechToTextModel>; }
export function loadStreamingSpeechToText(id: string, options: LoadSpeechToTextOptions = {}): Promise<StreamingSpeechToTextModel> { return load(id, options, true) as Promise<StreamingSpeechToTextModel>; }

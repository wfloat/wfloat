import { loadAssets } from '../assets/index';
import { checkAbort, notify, type DownloadModelOptions } from '../assets/types';
import { NativeInstance } from '../llm-native/instance';
import { NativeVadBackend } from './backend';
import { validateVadModel } from './backend-types';
import { VoiceActivityDetectionModel } from './model';
export async function loadVoiceActivityDetection(id: string, options: DownloadModelOptions = {}): Promise<VoiceActivityDetectionModel> {
  validateVadModel(id);
  const lease = await loadAssets(id, 'vad', options);
  const native = new NativeInstance();
  try {
    notify(options.onProgress, { phase: 'loading' });
    const loaded = await native.call<{ frameSize: number; sampleRate: number }>('load', { task: 'vad', modelId: id, family: lease.family, paths: lease.paths, options: {} }, { signal: lease.signal });
    if (loaded.frameSize !== 512 || loaded.sampleRate !== 16000) throw new Error('Native VAD requires 512-sample frames at 16000 Hz.');
    lease.assertCurrent(); checkAbort(lease.signal);
    const model = new VoiceActivityDetectionModel(new NativeVadBackend(native));
    lease.release(); notify(options.onProgress, { phase: 'ready' });
    return model;
  } catch (error) { await native.unload().catch(() => {}); checkAbort(lease.signal); throw error; }
  finally { lease.release(); }
}

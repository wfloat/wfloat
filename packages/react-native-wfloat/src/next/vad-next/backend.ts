import type { VadBackend } from './backend-types';
import { validateVadFrame } from './backend-types';
import { NativeInstance } from '../llm-native/instance';
export class NativeVadBackend implements VadBackend {
  readonly sampleRate = 16000 as const;
  readonly frameSize = 512;
  constructor(private readonly instance: NativeInstance) {}
  reset() { return this.instance.call<void>('resetVad'); }
  async score(samples: Float32Array) {
    validateVadFrame(samples);
    const probability = await this.instance.call<number>('scoreVad', { samples: Array.from(samples) });
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid native VAD probability.');
    return probability;
  }
  setFailureHandler(_handler: (error: Error) => void): void {}
  unload() { return this.instance.unload(); }
}

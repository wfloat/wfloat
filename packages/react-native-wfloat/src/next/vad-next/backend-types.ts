export interface VadBackend {
  readonly sampleRate: 16000;
  readonly frameSize: number;
  reset(): Promise<void>;
  score(samples: Float32Array): Promise<number>;
  setFailureHandler(fn: (error: Error) => void): void;
  unload(): Promise<void>;
}
export function validateVadModel(id: string): void {
  if (id !== 'snakers4/silero-vad') throw new Error(`Unsupported VAD model: ${id}`);
}
/** Frame assembly, resampling and final partial-frame padding belong to the model. */
export function validateVadFrame(samples: Float32Array): void {
  if (!(samples instanceof Float32Array) || samples.length !== 512) throw new TypeError('VAD requires exactly 512 Float32 PCM samples at 16000 Hz.');
  for (const sample of samples) if (!Number.isFinite(sample)) throw new TypeError('VAD PCM must contain only finite samples.');
}

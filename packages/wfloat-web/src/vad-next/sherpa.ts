import { validateVadFrame, validateVadModel, type WorkerAssets } from './backend-types.js';

/** Only the additive score bridge is required; no segment detector is created. */
export interface VadModule {
  wasmMemory: WebAssembly.Memory;
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToUTF8(text: string, ptr: number, size: number): void;
  FS: { writeFile(path: string, bytes: Uint8Array): void; unlink(path: string): void };
  _WfloatCreateVadScorer(path: number): number;
  _WfloatDestroyVadScorer(handle: number): void;
  _WfloatResetVadScorer(handle: number): number;
  _WfloatScoreVadFrame(handle: number, samples: number, count: number): number;
}
export class SherpaVadScorer {
  private handle = 0;
  private samplesPtr = 0;
  constructor(private module: VadModule, modelId: string, assets: WorkerAssets) {
    validateVadModel(modelId);
    if (!(assets.model instanceof Uint8Array) || !assets.model.byteLength) throw new Error('Missing VAD model asset.');
    for (const name of ['_WfloatCreateVadScorer', '_WfloatDestroyVadScorer', '_WfloatResetVadScorer', '_WfloatScoreVadFrame'] as const) {
      if (typeof module[name] !== 'function') throw new Error('Sherpa runtime is missing the VAD score bridge; rebuild speech WASM.');
    }
    const path = '/wfloat-vad.onnx';
    const pathSize = new TextEncoder().encode(path).length + 1;
    let pathPtr = 0;
    module.FS.writeFile(path, assets.model);
    try {
      pathPtr = module._malloc(pathSize);
      if (!pathPtr) throw new Error('Could not allocate VAD model path.');
      module.stringToUTF8(path, pathPtr, pathSize);
      this.handle = module._WfloatCreateVadScorer(pathPtr);
      if (!this.handle) throw new Error('Sherpa failed to create the VAD scorer.');
      this.samplesPtr = module._malloc(512 * 4);
      if (!this.samplesPtr) throw new Error('Could not allocate VAD input frame.');
    } catch (error) {
      this.unload(); throw error;
    } finally {
      if (pathPtr) module._free(pathPtr);
      // ORT owns the loaded weights. No duplicate model file retained in MEMFS.
      module.FS.unlink(path);
    }
  }
  private requireHandle() { if (!this.handle) throw new Error('VAD scorer is unloaded.'); }
  reset(): void {
    this.requireHandle();
    if (this.module._WfloatResetVadScorer(this.handle) !== 1) throw new Error('Sherpa VAD reset failed.');
  }
  score(samples: Float32Array): number {
    this.requireHandle(); validateVadFrame(samples);
    // Reacquire after every allocation/inference: WASM memory can grow.
    new Float32Array(this.module.wasmMemory.buffer, this.samplesPtr, 512).set(samples);
    const probability = this.module._WfloatScoreVadFrame(this.handle, this.samplesPtr, 512);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Sherpa VAD returned an invalid speech probability.');
    return probability;
  }
  unload(): void {
    if (this.handle) { this.module._WfloatDestroyVadScorer(this.handle); this.handle = 0; }
    if (this.samplesPtr) { this.module._free(this.samplesPtr); this.samplesPtr = 0; }
  }
}

import { normalizeAudio, snapshotAudio } from '../stt-next/audio.js';
import type { VadBackend } from './backend-types.js';
import { configuration } from './segmenter.js';
import { VadOperation } from './session.js';
import type { Detection, VadAudioInput, VadOptions, VadSession, VadSessionOptions } from './types.js';
export class VoiceActivityDetectionModel {
  private tail: Promise<void> = Promise.resolve();
  private operations = new Set<VadOperation>();
  private live?: VadOperation;
  private creating = false;
  private closed = false;
  private failure?: Error;
  private unloading?: Promise<void>;
  constructor(private backend: VadBackend) {
    backend.setFailureHandler(error => {
      this.failure = error;
      for (const operation of [...this.operations]) operation.fail(error);
    });
  }
  private available() {
    if (this.closed) throw new Error('VAD model is unloaded.');
    if (this.failure) throw this.failure;
  }
  private enqueue(work: () => Promise<void>) {
    const promise = this.tail.then(work); this.tail = promise.catch(() => {}); return promise;
  }
  detect<R extends boolean = false>(audio: VadAudioInput, options: VadOptions<R> = {}): Detection<R> {
    this.available();
    if (this.live || this.creating) throw new Error('An active live session owns this VAD model.');
    const config = configuration(options);
    // File operations expose probability updates, not live boundary/error callbacks.
    config.onSpeechStart = undefined; config.onSpeechEnd = undefined; config.onError = undefined;
    let input: ReturnType<typeof snapshotAudio> | undefined = snapshotAudio(audio);
    const operation = new VadOperation(this.backend, config, true, () => { this.operations.delete(operation); input = undefined; });
    this.operations.add(operation);
    void this.enqueue(async () => {
      if (!operation.active) return;
      try {
        const owned = input!; input = undefined;
        const normalized = await normalizeAudio(owned);
        if (!operation.active) return;
        await this.backend.reset();
        if (!operation.active) return;
        operation.begin();
        await operation.push(normalized);
        await operation.finish();
      } catch (error) { operation.fail(error); }
      finally { await operation.released; }
    });
    return operation as unknown as Detection<R>;
  }
  async createSession<R extends boolean = false>(options: VadSessionOptions<R> = {}): Promise<VadSession> {
    this.available();
    if (this.live || this.creating) throw new Error('A live session already owns this VAD model.');
    const config = configuration(options);
    this.creating = true;
    let operation: VadOperation | undefined;
    try {
      // Wait for earlier file detections before acquiring native state.
      await this.enqueue(async () => { this.available(); await this.backend.reset(); this.available(); });
      this.available();
      operation = new VadOperation(this.backend, config, false, () => {
        this.operations.delete(operation!);
        if (this.live === operation) this.live = undefined;
      });
      this.live = operation; this.operations.add(operation);
      operation.begin();
      // Later operations wait for actual in-flight native work, not merely JS cancellation.
      void this.enqueue(() => operation!.released);
      return operation;
    } finally { this.creating = false; }
  }
  unload(): Promise<void> {
    if (this.unloading) return this.unloading;
    this.closed = true;
    for (const operation of [...this.operations]) operation.cancel();
    this.unloading = this.enqueue(() => this.backend.unload());
    return this.unloading;
  }
}

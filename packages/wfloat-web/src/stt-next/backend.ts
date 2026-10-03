import type { RecognitionOptions, TranscriptData } from './types.js';
import type { SpeechToTextBackend, WorkerAssets, WorkerRequest, WorkerResponse } from './backend-types.js';
import { sttCapabilities, validateRecognitionOptions } from './capabilities.js';
export type { WorkerAssets } from './backend-types.js';
type Body = WorkerRequest extends infer R ? R extends WorkerRequest ? Omit<R, 'id'> : never : never;
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));
/** One dedicated worker and recognizer per model; caller owns operation scheduling. */
export class SherpaSpeechToTextBackend implements SpeechToTextBackend {
  readonly kind: 'offline' | 'online';
  private serial = 0;
  private closed = false;
  private fatal?: Error;
  private failureHandler?: (error: Error) => void;
  private unloading?: Promise<void>;
  private ready = false;
  private terminated = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(private worker: Worker, readonly modelId: string) {
    this.kind = sttCapabilities(modelId).kind;
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }
  setFailureHandler(handler: (error: Error) => void) {
    this.failureHandler = handler;
    if (this.fatal) handler(this.fatal);
  }
  private fail(error: Error) {
    if (this.fatal || (this.closed && this.pending.size === 0)) return;
    this.fatal = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.failureHandler?.(error);
  }
  private onError = (event: ErrorEvent) => this.fail(event.error instanceof Error ? event.error : new Error(event.message || 'STT worker failed.'));
  private onMessageError = () => this.fail(new Error('Could not decode STT worker response.'));
  private onMessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    let error: Error | undefined;
    if (response.error) {
      error = new Error(response.error.message); error.name = response.error.name;
      if (response.error.stack) error.stack = response.error.stack;
    }
    if (response.fatal) { this.fail(error ?? new Error('STT runtime aborted.')); return; }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (error) pending.reject(error); else pending.resolve(response.value);
  };
  private request<T>(body: Body, transfer: Transferable[] = []): Promise<T> {
    if (this.closed || this.fatal) return Promise.reject(this.fatal ?? new Error('STT backend is unloaded.'));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.worker.postMessage({ ...body, id }, transfer); }
      catch (error) { this.pending.delete(id); reject(asError(error)); }
    });
  }
  /** Consumes asset buffers, which must not be reused after initialization. */
  initialize(assets: WorkerAssets): Promise<void> {
    const transfer = [...new Set(Object.values(assets).map(bytes => bytes.buffer))].filter(buffer => buffer instanceof ArrayBuffer) as ArrayBuffer[];
    return this.request<void>({ type: 'init', modelId: this.modelId, assets }, transfer).then(() => {
      if (this.closed) throw this.fatal ?? new Error('STT initialization was cancelled.');
      this.ready = true;
    });
  }
  /** Loader-only escape hatch: interrupts initialization without waiting for WASM.
   * Once ready, ordinary unload retains native-safe teardown semantics. */
  abortInitialization(): void {
    if (this.ready || this.terminated) return;
    const error = new Error('STT initialization was aborted.');
    error.name = 'AbortError';
    this.closed = true;
    this.fatal = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.terminateWorker();
    this.unloading ??= Promise.resolve();
  }
  private terminateWorker() {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.terminate();
  }
  validate(options: RecognitionOptions) { validateRecognitionOptions(this.modelId, options); }
  configure(options: RecognitionOptions): Promise<void> {
    this.validate(options);
    return this.request({ type: 'configure', options: { language: options.language, task: options.task, timestamps: options.timestamps, ...(options.hotwords !== undefined ? { hotwords: [...options.hotwords] } : {}) } });
  }
  decode(samples: Float32Array) { return this.request<TranscriptData>({ type: 'decode', samples }); }
  openStream(): Promise<void> { return this.request({ type: 'open' }); }
  pushStream(samples: Float32Array, finish = false) { return this.request<{ text: string; isEndpoint: boolean }>({ type: 'push', samples, finish }); }
  resetStream(): Promise<void> { return this.request({ type: 'reset' }); }
  closeStream(): Promise<void> { return this.request({ type: 'close' }); }
  unload(): Promise<void> {
    if (this.unloading) return this.unloading;
    const completion = this.fatal ? Promise.resolve() : this.request<void>({ type: 'unload' });
    this.closed = true;
    this.unloading = completion.finally(() => {
      for (const pending of this.pending.values()) pending.reject(new Error('STT backend is unloaded.'));
      this.pending.clear();
      this.terminateWorker();
    });
    return this.unloading;
  }
}

import { SPEAKER_IDS, VALID_EMOTIONS } from '../tts/catalog.js';
import type { PreparedUnit, TextToSpeechBackend } from './backend-types.js';
import type { SpeechAudio, SpeechSegment } from './types.js';
import { asError, deferred } from './internal.js';

export function voiceNumber(voiceId: string | number | undefined): number {
  if (voiceId === undefined) return 0;
  if (typeof voiceId === 'number' && Number.isInteger(voiceId) && voiceId >= 0 && voiceId < 20) return voiceId;
  if (typeof voiceId === 'string' && Object.prototype.hasOwnProperty.call(SPEAKER_IDS, voiceId)) return SPEAKER_IDS[voiceId];
  throw new RangeError(`Invalid Wfloat voiceId: ${String(voiceId)}`);
}
export function validateWfloatSegment(segment: SpeechSegment) {
  voiceNumber(segment.voiceId);
  if (segment.emotion !== undefined && !(VALID_EMOTIONS as readonly string[]).includes(segment.emotion)) throw new RangeError(`Invalid Wfloat emotion: ${segment.emotion}`);
  if (segment.intensity !== undefined && (!Number.isFinite(segment.intensity) || segment.intensity < 0 || segment.intensity > 1)) throw new RangeError('Wfloat intensity must be between 0 and 1.');
  if (segment.speed !== undefined && (!Number.isFinite(segment.speed) || segment.speed <= 0)) throw new RangeError('Wfloat speed must be finite and positive.');
}
export type WorkerAssets = { wasm: Uint8Array; model: Uint8Array; tokens: Uint8Array; espeak: Uint8Array };
export type WorkerRequest =
  | { id: number; type: 'init'; assets: WorkerAssets }
  | { id: number; type: 'prepare'; segment: SpeechSegment }
  | { id: number; type: 'synthesize'; unit: PreparedUnit; segment: SpeechSegment };
export type WorkerResponse = { id: number; value?: unknown; error?: { message: string; name: string; stack?: string } };
type RequestBody = WorkerRequest extends infer R ? R extends WorkerRequest ? Omit<R, 'id'> : never : never;

/** Concrete sherpa RPC adapter; never shares worker or inference state across models. */
export class SherpaTextToSpeechBackend implements TextToSpeechBackend {
  sampleRate = 0;
  private serial = 0;
  private closed = false;
  private pending = new Map<number, ReturnType<typeof deferred<unknown>>>();
  constructor(private worker: Worker) {
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onError);
    worker.addEventListener('messageerror', this.onMessageError);
  }
  private onMessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.stack) error.stack = response.error.stack;
      pending.reject(error);
    } else pending.resolve(response.value);
  };
  private rejectPending(error: Error) { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  private onError = (event: ErrorEvent) => { this.rejectPending(event.error instanceof Error ? event.error : new Error(event.message || 'TTS worker failed.')); };
  private onMessageError = () => { this.rejectPending(new Error('Could not decode TTS worker response.')); };
  private request<T>(body: RequestBody, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('TTS backend is unloaded.'));
    const id = ++this.serial;
    const request = deferred<unknown>();
    this.pending.set(id, request);
    try { this.worker.postMessage({ ...body, id }, transfer); }
    catch (error) { this.pending.delete(id); request.reject(asError(error)); }
    return request.promise as Promise<T>;
  }
  async initialize(assets: WorkerAssets) {
    const result = await this.request<{ sampleRate: number }>({ type: 'init', assets }, Object.values(assets).map(bytes => bytes.buffer as ArrayBuffer));
    this.sampleRate = result.sampleRate;
  }
  validate(segment: SpeechSegment) { validateWfloatSegment(segment); }
  prepare(segment: SpeechSegment) { return this.request<PreparedUnit[]>({ type: 'prepare', segment }); }
  synthesize(unit: PreparedUnit, segment: SpeechSegment) { return this.request<SpeechAudio>({ type: 'synthesize', unit, segment }); }
  async unload() {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('TTS backend is unloaded.'));
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.terminate();
  }
}

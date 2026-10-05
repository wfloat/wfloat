import { validateStandardSegment, type StandardConfig } from './families.js';
import { validateSampling, validatePocketSegment } from './pocket.js';
import { normalizeAudio } from '../stt-next/audio.js';
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
  validateSampling(segment);
  if (segment.referenceAudio !== undefined) throw new TypeError('This model does not support referenceAudio.');
  voiceNumber(segment.voiceId);
  if (segment.emotion !== undefined && !(VALID_EMOTIONS as readonly string[]).includes(segment.emotion)) throw new RangeError(`Invalid Wfloat emotion: ${segment.emotion}`);
  if (segment.intensity !== undefined && (!Number.isFinite(segment.intensity) || segment.intensity < 0 || segment.intensity > 1)) throw new RangeError('Wfloat intensity must be between 0 and 1.');
  if (segment.speed !== undefined && (!Number.isFinite(segment.speed) || segment.speed <= 0)) throw new RangeError('Wfloat speed must be finite and positive.');
}
export type StandardAssets = { wasm: Uint8Array; family: 'piper' | 'kokoro' | 'kitten'; config: StandardConfig; files: Record<string, Uint8Array>; espeak: Uint8Array };
export type WorkerAssets = StandardAssets | { wasm: Uint8Array; model: Uint8Array; tokens: Uint8Array; espeak: Uint8Array } | { wasm: Uint8Array; family: 'pocket'; files: Record<string, Uint8Array> };
export type WorkerRequest =
  | { id: number; type: 'init'; assets: WorkerAssets }
  | { id: number; type: 'prepare'; segment: SpeechSegment }
  | { id: number; type: 'synthesize'; unit: PreparedUnit; segment: SpeechSegment };
export type WorkerResponse = { id: number; value?: unknown; error?: { message: string; name: string; stack?: string } };
type RequestBody = WorkerRequest extends infer R ? R extends WorkerRequest ? Omit<R, 'id'> : never : never;

/** Concrete sherpa RPC adapter; never shares worker or inference state across models. */
export class SherpaTextToSpeechBackend implements TextToSpeechBackend {
  sampleRate = 0;
  private family: 'wfloat' | 'pocket' | 'piper' | 'kokoro' | 'kitten' = 'wfloat';
  private config?: StandardConfig;
  private references = new WeakMap<object, Promise<SpeechAudio>>();
  private warned = new Set<string>();
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
    this.family = 'family' in assets ? assets.family : 'wfloat';
    this.config = 'config' in assets ? assets.config : undefined;
    const buffers = 'family' in assets ? [assets.wasm, ...Object.values(assets.files), ...('espeak' in assets ? [assets.espeak] : [])] : Object.values(assets);
    const result = await this.request<{ sampleRate: number }>({ type: 'init', assets }, [...new Set(buffers.map(bytes => bytes.buffer as ArrayBuffer))]);
    this.sampleRate = result.sampleRate;
  }
  validate(segment: SpeechSegment) {
    if (this.config) validateStandardSegment(this.config, segment);
    else if (this.family === 'pocket') validatePocketSegment(segment); else validateWfloatSegment(segment);
    const ignored = this.config ? ['emotion', 'intensity', 'temperature', 'seed', 'inferenceSteps'] as const : this.family === 'pocket' ? ['emotion', 'intensity', 'speed'] as const : ['temperature', 'seed', 'inferenceSteps'] as const;
    for (const key of ignored) if (segment[key] !== undefined && !this.warned.has(key)) {
      this.warned.add(key); console.warn(`${key} has no effect on the ${this.family} TTS model.`);
    }
  }
  prepare(segment: SpeechSegment) { return this.request<PreparedUnit[]>({ type: 'prepare', segment }); }
  async synthesize(unit: PreparedUnit, segment: SpeechSegment) {
    let normalized = segment;
    if (this.family === 'pocket' && segment.referenceAudio) {
      const source = segment.referenceAudio;
      let pending = this.references.get(source);
      if (!pending) {
        pending = normalizeAudio(source as import('../stt-next/types.js').PcmAudio | Blob, 24000).then(audio => {
          if (audio.samples.length > 240000) throw new RangeError('Pocket referenceAudio must be at most 10 seconds.');
          return audio;
        });
        this.references.set(source, pending);
      }
      normalized = { ...segment, referenceAudio: await pending };
    }
    return this.request<SpeechAudio>({ type: 'synthesize', unit, segment: normalized });
  }
  async unload() {
    if (this.closed) return;
    this.closed = true;
    this.references = new WeakMap();
    this.rejectPending(new Error('TTS backend is unloaded.'));
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.removeEventListener('messageerror', this.onMessageError);
    this.worker.terminate();
  }
}

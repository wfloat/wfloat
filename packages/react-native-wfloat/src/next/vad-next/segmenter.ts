import { AudioQueue } from '../stt-next/transcript';
import { notify } from '../tts-next/internal';
import type { VadSessionOptions, VadSpeechRange, VadSpeechSegment } from './types';
export type Config = Required<Pick<VadSessionOptions<boolean>, 'speechThreshold' | 'silenceThreshold' | 'minSpeechDurationMs' | 'minSilenceDurationMs' | 'speechPaddingMs' | 'returnAudio'>> & VadSessionOptions<boolean>;
export function configuration<R extends boolean>(options: VadSessionOptions<R>): Config {
  if (!options || typeof options !== 'object') throw new TypeError('VAD options must be an object.');
  const config = { speechThreshold: 0.5, silenceThreshold: Math.max(0, (options.speechThreshold ?? 0.5) - 0.15), minSpeechDurationMs: 250, minSilenceDurationMs: 500, speechPaddingMs: 30, returnAudio: false, ...options };
  // Explicit undefined has the same meaning as omission.
  for (const [name, value] of Object.entries({ speechThreshold: 0.5, silenceThreshold: Math.max(0, (options.speechThreshold ?? 0.5) - 0.15), minSpeechDurationMs: 250, minSilenceDurationMs: 500, speechPaddingMs: 30, returnAudio: false })) {
    if ((config as any)[name] === undefined) (config as any)[name] = value;
  }
  for (const key of ['speechThreshold', 'silenceThreshold'] as const) if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new TypeError(`${key} must be between 0 and 1.`);
  if (config.silenceThreshold > config.speechThreshold) throw new TypeError('silenceThreshold must not exceed speechThreshold.');
  for (const key of ['minSpeechDurationMs', 'minSilenceDurationMs', 'speechPaddingMs'] as const) if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0 || !Number.isSafeInteger(Math.ceil(config[key] * 16))) throw new TypeError(`${key} must be a nonnegative finite duration.`);
  if (typeof config.returnAudio !== 'boolean') throw new TypeError('returnAudio must be boolean.');
  for (const key of ['onProbability', 'onSpeechStart', 'onSpeechEnd', 'onError'] as const) if (config[key] !== undefined && typeof config[key] !== 'function') throw new TypeError(`${key} must be a function.`);
  return config as Config;
}
/** Model scores enter once, in chronological order. Padding/confirmation belongs
 * to Wfloat, not the backend's inconsistent segmentation policies. */
export class Segmenter {
  readonly segments: VadSpeechRange[] = [];
  private clips: VadSpeechSegment<true>[] = [];
  private position = 0;
  private notificationsCancelled = false;
  cancelNotifications() { this.notificationsCancelled = true; }
  private emit<T>(callback: ((event: T) => void) | undefined, event: T) {
    notify(callback ? value => { if (!this.notificationsCancelled) return callback(value); } : undefined, event);
  }
  private candidate?: number;
  private active?: { id: string; start: number };
  private silence?: number;
  private previousEnd = 0;
  private retained = new AudioQueue();
  private retainedStart = 0;
  constructor(private config: Config, private file: boolean, private rate = 16000) {}
  private samples(ms: number) { return Math.ceil(ms * this.rate / 1000); }
  private ms(sample: number) { return sample / this.rate * 1000; }
  feed(audio: Float32Array, probability: number) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('VAD backend returned an invalid speech probability.');
    const start = this.position, end = start + audio.length;
    if (this.config.returnAudio) this.retained.append(audio);
    this.position = end;
    this.emit(this.config.onProbability, { probability, startMs: this.ms(start), endMs: this.ms(end) });
    if (!this.active) {
      if (probability >= this.config.speechThreshold) {
        this.candidate ??= start;
        if (end - this.candidate >= this.samples(this.config.minSpeechDurationMs)) {
          this.active = { id: String(this.segments.length), start: Math.max(this.previousEnd, 0, this.candidate - this.samples(this.config.speechPaddingMs)) };
          this.emit(this.config.onSpeechStart, { id: this.active.id, startMs: this.ms(this.active.start) });
        }
      } else this.candidate = undefined;
    } else if (probability < this.config.silenceThreshold) {
      this.silence ??= start;
      if (end - this.silence >= this.samples(this.config.minSilenceDurationMs)) this.close(Math.min(end, this.silence + this.samples(this.config.speechPaddingMs)));
    } else this.silence = undefined;
    this.trim();
  }
  private close(end: number) {
    if (!this.active) return;
    end = Math.max(this.active.start, Math.min(end, this.position));
    const range = { id: this.active.id, startMs: this.ms(this.active.start), endMs: this.ms(end) };
    let segment: VadSpeechSegment<boolean> = range;
    if (this.config.returnAudio) {
      const data = this.retained.peek(end - this.retainedStart);
      const samples = data.slice(this.active.start - this.retainedStart);
      segment = { ...range, audio: { samples, sampleRate: this.rate } };
      if (this.file) this.clips.push(segment as VadSpeechSegment<true>);
    }
    // Notification objects never alias the retained result's metadata.
    this.segments.push(range);
    this.emit(this.config.onSpeechEnd, { ...segment });
    this.previousEnd = end;
    this.active = undefined; this.candidate = undefined; this.silence = undefined;
  }
  finish() {
    if (this.active) this.close(this.silence === undefined ? this.position : Math.min(this.position, this.silence + this.samples(this.config.speechPaddingMs)));
    this.clear();
  }
  private trim() {
    if (!this.config.returnAudio) return;
    const keep = this.active?.start ?? Math.max(this.previousEnd, (this.candidate ?? this.position) - this.samples(this.config.speechPaddingMs), 0);
    this.retained.discard(Math.max(0, keep - this.retainedStart));
    this.retainedStart = keep;
  }
  snapshot(): { segments: VadSpeechSegment<boolean>[] } {
    return { segments: (this.file && this.config.returnAudio ? this.clips : this.segments).map(s => ({ ...s, ...('audio' in s ? { audio: { ...(s as VadSpeechSegment<true>).audio } } : {}) })) };
  }
  clear() { this.retained.clear(); this.active = undefined; this.candidate = undefined; this.silence = undefined; }
}

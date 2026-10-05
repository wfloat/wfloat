import type { SpeechChunk } from './types.js';
/** Internal seam for deterministic playback-clock tests. Each speech owns a driver. */
export interface PlaybackDriver {
  start(chunks: readonly SpeechChunk[], positionMs: number): Promise<void>;
  append(chunks: readonly SpeechChunk[]): void;
  positionMs(): number;
  stop(): void;
  close(): void;
}
export type PlaybackFactory = () => PlaybackDriver;

function createAudioContext(): AudioContext {
  const Constructor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) throw new Error('Web Audio is unavailable.');
  return new Constructor();
}
/** Lazy per-model context: paused previews retain sources/data, not extra contexts. */
export function createModelPlayback() {
  let context: AudioContext | undefined;
  let cleanup: Promise<void> | undefined;
  return {
    create: () => new WebAudioPlayback(context ??= createAudioContext()),
    close: (): Promise<void> => {
      if (!cleanup) {
        const closing = context;
        context = undefined;
        cleanup = Promise.resolve().then(() => closing?.close());
      }
      return cleanup;
    },
  };
}

/** Sources are scheduled on the audio clock, never chained through onended. */
export class WebAudioPlayback implements PlaybackDriver {
  private context: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private origin = 0;
  private position = 0;
  private end = 0;
  private running = false;
  private pending: SpeechChunk[] = [];
  private epoch = 0;
  private ownsContext: boolean;
  constructor(context?: AudioContext) {
    this.ownsContext = context === undefined;
    this.context = context ?? createAudioContext();
    // Preserve gesture-based unlock before asynchronous inference.
    void this.context.resume().catch(() => {});
  }
  async start(chunks: readonly SpeechChunk[], positionMs: number) {
    this.stop();
    const epoch = this.epoch;
    this.position = positionMs;
    this.end = positionMs;
    this.pending.push(...chunks);
    await this.context.resume();
    if (epoch !== this.epoch) return;
    this.origin = this.context.currentTime - positionMs / 1000;
    this.running = true;
    const pending = this.pending;
    this.pending = [];
    this.append(pending);
  }
  append(chunks: readonly SpeechChunk[]) {
    if (!this.running) { this.pending.push(...chunks); return; }
    for (const chunk of chunks) {
      const end = chunk.startMs + chunk.audio.samples.length / chunk.audio.sampleRate * 1000;
      const position = this.positionMs();
      if (end <= position) continue;
      const buffer = this.context.createBuffer(1, chunk.audio.samples.length, chunk.audio.sampleRate);
      buffer.getChannelData(0).set(chunk.audio.samples);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      const offsetMs = Math.max(0, this.position - chunk.startMs);
      // Allocation/copying can itself outlast the buffered audio. Read the clock
      // after that work so an underrun never consumes audio not yet scheduled.
      // On resume, the first chunk may straddle the saved position.
      const now = this.context.currentTime;
      if (now > this.origin + this.end / 1000 && Math.max(chunk.startMs, this.position) >= this.end) {
        this.origin = now - this.end / 1000;
      }
      try {
        source.start(Math.max(now, this.origin + (chunk.startMs + offsetMs) / 1000), offsetMs / 1000);
      } catch (error) {
        // stop() is invalid until start() succeeds. Do not let failure cleanup
        // replace the original error or strand the speech before its callback.
        source.disconnect();
        throw error;
      }
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); };
      this.end = Math.max(this.end, end);
    }
  }
  positionMs() { return this.running ? Math.min(this.end, Math.max(this.position, (this.context.currentTime - this.origin) * 1000)) : this.position; }
  stop() {
    this.epoch++;
    this.position = this.positionMs();
    this.running = false;
    this.pending = [];
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
  }
  close() { this.stop(); if (this.ownsContext) void this.context.close().catch(() => {}); }
}

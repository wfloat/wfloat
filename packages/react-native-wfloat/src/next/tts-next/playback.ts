import { request, subscribe, uniqueId } from '../platform/bridge';
import type { SpeechChunk, PlaybackOptions } from './types';
import { asError } from './internal';
export interface PlaybackDriver {
  /** Continue-mode lease acquisition; direct synthesis waits for this prerequisite. */
  readonly ready?: Promise<void>;
  /** Renew preparation on explicit activation after a prepared-only pause. */
  activate?(): void;
  start(chunks: readonly SpeechChunk[], positionMs: number): Promise<void>;
  append(chunks: readonly SpeechChunk[]): void;
  positionMs(): number;
  /** Native audio-clock notifications; absent only on injected polling drivers. */
  onPosition?(handler: () => void): () => void;
  stop(): void;
  close(): void;
}
export type PlaybackStateHandler = (state: 'paused' | 'failed' | 'resumed', error?: Error) => void;
export type PlaybackFactory = (options?: PlaybackOptions, onState?: PlaybackStateHandler) => PlaybackDriver;

export function validatePlaybackOptions(options: PlaybackOptions): void {
  if (options.backgroundBehavior !== undefined && !['continue', 'pauseAndAutoResume', 'pauseUntilResumed'].includes(options.backgroundBehavior)) throw new TypeError('Invalid playback backgroundBehavior.');
  if (options.audioFocus !== undefined && !['interruptOthers', 'duckOthers', 'mixWithOthers'].includes(options.audioFocus)) throw new TypeError('Invalid playback audioFocus.');
}

/** Model owns cleanup; each speech retains its native queue while paused. */
export function createModelPlayback() {
  const drivers = new Set<NativePlayback>();
  return {
    create: (options?: PlaybackOptions, onState?: PlaybackStateHandler) => {
      const driver = new NativePlayback(options, onState, () => drivers.delete(driver));
      drivers.add(driver); return driver;
    },
    close: async () => { await Promise.all([...drivers].map(driver => driver.dispose())); },
  };
}

/** Position comes from the native audio clock, never elapsed JS wall time. */
export class NativePlayback implements PlaybackDriver {
  private readonly playbackId = uniqueId('playback');
  private readonly requestId = uniqueId('playback-events');
  private readonly options: Pick<PlaybackOptions, 'backgroundBehavior' | 'audioFocus'>;
  private detach?: () => void;
  private position = 0;
  private sentEnd = 0;
  private rate?: number;
  private preparation?: Promise<void>;
  get ready(): Promise<void> | undefined { return this.preparation; }
  private preparationRequested = false;
  private prepared = false;
  private failure?: Error;
  private created = false;
  private closed = false;
  private explicitPause = false;
  private pausing = false;
  private epoch = 0;
  private positionHandler?: () => void;
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  constructor(options: PlaybackOptions = {}, private readonly onState?: PlaybackStateHandler, private readonly onClose?: () => void) {
    const backgroundBehavior = options.backgroundBehavior ?? 'pauseUntilResumed';
    const audioFocus = options.audioFocus ?? 'interruptOthers';
    validatePlaybackOptions(options);
    this.options = { backgroundBehavior, audioFocus };
    this.activate();
  }
  activate(): void {
    if (this.closed) return;
    this.explicitPause = false;
    if (this.options.backgroundBehavior !== 'continue' || this.preparation) return;
    // A stop invalidates this promise immediately; queued pause releases the old
    // lease before this fresh acquisition executes. Callbacks remain deferred.
    this.preparation = this.enqueue(async () => {
      if (this.closed) return;
      this.listen();
      this.preparationRequested = true;
      await request({ op: 'playbackPrepare', playbackId: this.playbackId, options: this.options }, { requestId: this.requestId });
      this.prepared = true;
      if (this.failure) throw this.failure;
    });
    void this.preparation.catch(error => this.failed(error));
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(work);
    // Observe failures while keeping teardown reachable after a rejected operation.
    this.tail = pending.catch(() => {});
    return pending;
  }
  private failed(error: unknown) {
    if (this.closed || this.failure) return;
    this.failure = asError(error);
    try { this.onState?.('failed', this.failure); }
    finally { this.close(); }
  }
  onPosition(handler: () => void): () => void {
    this.positionHandler = handler;
    return () => { if (this.positionHandler === handler) this.positionHandler = undefined; };
  }
  private acceptPosition(value: number) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid native playback position.');
    this.position = Math.max(this.position, Math.min(this.sentEnd, value));
  }
  private async readPosition() {
    const value = await request<number>({ op: 'playbackPosition', playbackId: this.playbackId });
    this.acceptPosition(value);
  }
  private listen() {
    if (this.detach) return;
    this.detach = subscribe(this.requestId, event => {
      if (this.closed) return;
      if (event.type === 'playbackPosition') {
        // Serialize with start/append/state changes. Final-drain events must also
        // drive completion and refill when JS timers are suspended.
        void this.enqueue(async () => {
          if (this.closed) return;
          this.acceptPosition(event.positionMs);
          if (!this.explicitPause) this.positionHandler?.();
        }).catch(error => this.failed(error));
        return;
      }
      if (event.type !== 'playbackState') return;
      if (event.state === 'failed') { this.failed(new Error(event.message ?? 'Native playback failed.')); return; }
      if (event.state === 'paused') {
        // An explicit pause acknowledgement can arrive after activate() queued a
        // resume. It is not a new OS suspension of that resumed operation.
        if (this.pausing) return;
        // OS pauses must not send playbackPause: that would erase auto-resume intent.
        if (!this.explicitPause) void this.enqueue(async () => {
          if (this.created) await this.readPosition();
          if (!this.closed && !this.explicitPause) {
            this.preparation = undefined; this.prepared = false;
            this.onState?.('paused');
          }
        }).catch(error => this.failed(error));
      } else if (event.state === 'resumed' && !this.explicitPause) {
        void this.enqueue(async () => {
          if (!this.closed && !this.explicitPause) { if (this.created) await this.readPosition(); this.onState?.('resumed'); }
        }).catch(error => this.failed(error));
      }
    });
  }
  private samples(chunks: readonly SpeechChunk[], position: number): number[] {
    const output: number[] = [];
    let end = this.sentEnd;
    for (const chunk of chunks) {
      if (this.rate === undefined) this.rate = chunk.audio.sampleRate;
      if (chunk.audio.sampleRate !== this.rate) throw new Error('Playback sample rate changed.');
      const offset = Math.max(0, Math.round((Math.max(position, end) - chunk.startMs) * this.rate / 1000));
      for (let i = offset; i < chunk.audio.samples.length; i++) output.push(chunk.audio.samples[i]!);
      end = Math.max(end, chunk.startMs + chunk.audio.samples.length / this.rate * 1000);
    }
    this.sentEnd = end;
    return output;
  }
  start(chunks: readonly SpeechChunk[], positionMs: number): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('Playback is closed.'));
    this.activate();
    const epoch = ++this.epoch;
    return this.enqueue(async () => {
      if (this.failure) throw this.failure;
      if (this.closed || epoch !== this.epoch) return;
      if (this.options.backgroundBehavior === 'continue' && !this.created && !this.prepared) throw new Error('Playback lease preparation did not complete.');
      if (!this.created) {
        this.position = positionMs; this.sentEnd = positionMs;
        const samples = this.samples(chunks, positionMs);
        if (!samples.length || this.rate === undefined) throw new Error('Playback needs nonempty PCM.');
        this.listen();
        // Mark before dispatch so even a failed/partially allocated start gets closed.
        this.created = true;
        await request({ op: 'playbackStart', playbackId: this.playbackId, sampleRate: this.rate, samples, offsetMs: positionMs, options: this.options }, { requestId: this.requestId });
      } else {
        // Native pause retains queued PCM; resume never resubmits that audio.
        await request({ op: 'playbackStart', playbackId: this.playbackId, sampleRate: this.rate, samples: [], offsetMs: positionMs, options: this.options }, { requestId: this.requestId });
        const samples = this.samples(chunks, this.sentEnd);
        if (samples.length) await request({ op: 'playbackAppend', playbackId: this.playbackId, samples });
      }
      if (epoch === this.epoch && !this.closed) { await this.readPosition(); }
    });
  }
  append(chunks: readonly SpeechChunk[]) {
    if (this.closed) return;
    void this.enqueue(async () => {
      if (this.closed) return;
      const samples = this.samples(chunks, this.sentEnd);
      if (samples.length) await request({ op: 'playbackAppend', playbackId: this.playbackId, samples });
    }).catch(error => this.failed(error));
  }
  positionMs() { return this.position; }
  stop() {
    if (this.closed) return;
    this.epoch++; this.explicitPause = true;
    this.preparation = undefined;
    void this.enqueue(async () => {
      if ((this.created || this.prepared) && !this.closed) {
        this.pausing = true;
        try { await request({ op: 'playbackPause', playbackId: this.playbackId }); }
        finally { this.pausing = false; }
        // Prepared-only pause releases the service lease without creating PCM.
        // Position is defined only after playbackStart allocated a native player.
        if (this.created) await this.readPosition();
        this.prepared = false;
      }
    }).catch(error => this.failed(error));
  }
  close() { void this.dispose().catch(error => console.error('Wfloat playback cleanup failed:', error)); }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.epoch++; this.positionHandler = undefined; this.detach?.(); this.detach = undefined;
    this.closing = this.enqueue(async () => {
      try { if (this.preparationRequested || this.created) await request({ op: 'playbackClose', playbackId: this.playbackId }); }
      finally { this.onClose?.(); }
    });
    return this.closing;
  }
}

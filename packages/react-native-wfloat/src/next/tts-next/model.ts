import { asyncIteratorKey } from '../llm-native/async-iterator';
import type { TextToSpeechBackend, PreparedUnit } from './backend-types';
import type { GenerateOptions, PlaybackEvent, PlaybackOptions, SpeakOptions, SpeechChunk, SpeechGeneration, SpeechHandle, SpeechHighlight, SpeechResult, SpeechSegment } from './types';
import { asError, closedError, deferred, notify } from './internal';
import { createModelPlayback, validatePlaybackOptions, type PlaybackDriver, type PlaybackFactory } from './playback';

const AHEAD_MS = 10_000;

/** Loaded instances own their inference queue and playback arbitration. */
export class TextToSpeechModel {
  private jobs = new Set<Generation>();
  private active?: Speech;
  private pumping = false;
  private closed = false;
  private cleanup?: Promise<void>;
  private warned = false;
  private readonly playback: PlaybackFactory;
  private readonly closePlayback: () => Promise<void>;
  constructor(private readonly backend: TextToSpeechBackend, playback?: PlaybackFactory) {
    const audio = playback ? undefined : createModelPlayback();
    this.playback = playback ?? audio!.create;
    this.closePlayback = audio?.close ?? (async () => {});
    if (!(backend.sampleRate > 0) || !Number.isFinite(backend.sampleRate)) throw new Error('Invalid backend sample rate.');
  }
  generate(text: string, options: GenerateOptions = {}): SpeechGeneration { return this.generateDialogue([{ text }], options); }
  generateDialogue(segments: readonly SpeechSegment[], options: GenerateOptions = {}): SpeechGeneration {
    return this.create(segments, options, true);
  }
  speak(text: string, options: SpeakOptions = {}): SpeechHandle { return this.speakDialogue([{ text }], options); }
  speakDialogue(segments: readonly SpeechSegment[], options: SpeakOptions = {}): SpeechHandle {
    validatePlaybackOptions(options);
    const job = this.create(segments, options, false);
    return this.attach(job, options);
  }
  private create(segments: readonly SpeechSegment[], options: GenerateOptions, retained: boolean) {
    if (this.closed) throw new Error('Text-to-speech model is unloaded.');
    if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('Dialogue requires at least one segment.');
    const gap = options.pauseBetweenSegmentsMs ?? 0;
    validatePause(gap, this.backend.sampleRate);
    let pauseSamples = 0;
    const snapshot = Array.from(segments, (input, index) => {
      if (!Object.prototype.hasOwnProperty.call(segments, index)) throw new TypeError('Dialogue segments must be a dense array.');
      if (!input || typeof input.text !== 'string' || !input.text.trim()) throw new TypeError('Speech text must not be blank.');
      const segment: SpeechSegment = {
        text: input.text,
        voiceId: input.voiceId ?? options.voiceId,
        emotion: input.emotion ?? options.emotion,
        intensity: input.intensity ?? options.intensity,
        speed: input.speed ?? options.speed,
        pauseAfterMs: input.pauseAfterMs ?? (index + 1 < segments.length ? gap : 0),
      };
      pauseSamples += validatePause(segment.pauseAfterMs!, this.backend.sampleRate);
      if (!Number.isSafeInteger(pauseSamples)) throw new RangeError('Total pauses exceed representable audio length.');
      this.backend.validate(segment);
      return segment;
    });
    const job = new Generation(this, snapshot, retained, this.backend.sampleRate);
    this.jobs.add(job);
    if (!this.warned && this.jobs.size >= 32) {
      this.warned = true;
      // No eviction: pause retains; cancel/dispose releases.
      if ((globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production') {
        console.warn('Many unfinished or retained speech handles. Pause retains audio; cancel speech or dispose generations to release it.');
      }
    }
    this.wake();
    return job;
  }
  /** @internal */
  attach(job: Generation, options: PlaybackOptions): Speech {
    validatePlaybackOptions(options);
    job.assertOpen();
    if (this.closed) throw new Error('Text-to-speech model is unloaded.');
    const speech = new Speech(this, job, options.onPlayback);
    job.children.add(speech);
    // Initialization failure is local to this playback, and is delivered after handle return.
    try { speech.driver = this.playback(options, (state, error) => {
      if (state === 'failed') speech.fail(error ?? new Error('Native playback failed.'));
      else if (state === 'resumed') speech.resumeFromNative();
      else speech.suspend();
    }); speech.observePosition(); }
    catch (error) { queueMicrotask(() => speech.fail(asError(error))); }
    this.activate(speech);
    return speech;
  }
  /** @internal */
  activate(speech: Speech) {
    if (this.closed || speech.terminal) return;
    if (this.active !== speech) this.active?.pause();
    this.active = speech;
    speech.paused = false;
    try { speech.driver?.activate?.(); }
    catch (error) { speech.fail(asError(error)); return; }
    speech.update();
    this.wake();
  }
  /** @internal */
  release(speech: Speech) { if (this.active === speech) this.active = undefined; this.wake(); }
  /** @internal */
  forget(job: Generation) { this.jobs.delete(job); this.wake(); }
  /** @internal */
  wake() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    queueMicrotask(() => { void this.pump(); });
  }
  private async pump() {
    try {
      while (!this.closed) {
        const foreground = this.active?.job;
        let job = foreground && !foreground.done && !foreground.error && !foreground.disposed &&
          foreground.durationMs - this.active!.positionMs < AHEAD_MS ? foreground : undefined;
        job ??= [...this.jobs].find(candidate => candidate !== foreground && candidate.retained && candidate.runnable);
        job ??= foreground?.retained && foreground.runnable ? foreground : undefined;
        if (!job) break;
        const speech = this.active;
        const ready = speech?.driver?.ready;
        if (job === foreground && !job.retained && speech && ready) {
          // Direct speech acquires its continue-mode lease before first synthesis.
          // Independently owned generations keep their existing scheduling rules.
          try { await ready; }
          catch (error) { speech.fail(asError(error)); continue; }
          if (this.active !== speech || speech.terminal || speech.paused || speech.driver?.ready !== ready) continue;
        }
        try { await job.step(this.backend); }
        catch (error) { job.fail(asError(error)); }
      }
    } finally { this.pumping = false; }
  }
  unload(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    for (const job of [...this.jobs]) job.dispose();
    this.active = undefined;
    // Wait for both resources even if one cleanup rejects; neither may be skipped.
    this.cleanup = Promise.allSettled([
      Promise.resolve().then(() => this.closePlayback()),
      Promise.resolve().then(() => this.backend.unload()),
    ]).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    return this.cleanup;
  }
}

function validatePause(value: number, sampleRate: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Pause must be a finite nonnegative number of milliseconds.');
  const samples = Math.round(value * sampleRate / 1000);
  if (!Number.isSafeInteger(samples)) throw new RangeError('Pause exceeds representable audio length.');
  return samples;
}

class Generation implements SpeechGeneration {
  readonly completion = deferred<void>();
  private observed = false;
  get finished() { this.observed = true; return this.completion.promise; }
  readonly children = new Set<Speech>();
  readonly chunks: SpeechChunk[] = [];
  baseIndex = 0;
  done = false;
  disposed = false;
  error?: Error;
  private changed = deferred<void>();
  private assembly?: Promise<SpeechResult>;
  private segmentIndex = 0;
  private units?: PreparedUnit[];
  private unitIndex = 0;
  private sampleCount = 0;
  private silenceRemaining = 0;
  private segmentAudioDone = false;
  private synthesisRatio = 0;
  constructor(readonly model: TextToSpeechModel, readonly segments: SpeechSegment[], readonly retained: boolean, readonly sampleRate: number) {}
  get runnable() { return !this.done && !this.disposed && !this.error; }
  get durationMs() { return this.sampleCount / this.sampleRate * 1000; }
  // Adapt to measured synthesis/audio ratio, bounded by direct-speech lookahead.
  get startBufferMs() { return Math.min(3000, Math.max(200, 1000 * this.synthesisRatio)); }
  assertOpen() { if (this.disposed) throw closedError(); if (this.error) throw this.error; }
  private signal() { this.changed.resolve(); this.changed = deferred<void>(); for (const child of [...this.children]) child.update(); }
  async step(backend: TextToSpeechBackend) {
    if (!this.runnable) return;
    const segment = this.segments[this.segmentIndex]!;
    if (!this.units) {
      const units = await backend.prepare(segment);
      if (!this.runnable) return;
      if (!units.length) throw new Error('Backend prepared no speech for nonblank text.');
      let previousEnd = 0;
      for (const unit of units) {
        if (!unit.text || !Number.isInteger(unit.textStart) || !Number.isInteger(unit.textEnd) || unit.textStart < previousEnd || unit.textEnd <= unit.textStart || unit.textEnd > segment.text.length) throw new Error('Invalid backend text alignment.');
        previousEnd = unit.textEnd;
      }
      this.units = units;
      return;
    }
    if (this.unitIndex < this.units.length) {
      const unit = this.units[this.unitIndex]!;
      const start = performance.now();
      const audio = await backend.synthesize(unit, segment);
      if (!this.runnable) return;
      if (!(audio.samples instanceof Float32Array) || !audio.samples.length || audio.sampleRate !== this.sampleRate) throw new Error('Backend returned empty audio or an inconsistent sample rate.');
      const duration = audio.samples.length / this.sampleRate * 1000;
      const ratio = (performance.now() - start) / duration;
      this.synthesisRatio = this.synthesisRatio ? this.synthesisRatio * 0.7 + ratio * 0.3 : ratio;
      const startMs = this.durationMs;
      this.unitIndex++;
      this.append({ audio, startMs, timeline: [{ segmentIndex: this.segmentIndex, textStart: unit.textStart, textEnd: unit.textEnd, text: segment.text.slice(unit.textStart, unit.textEnd), startMs, endMs: startMs + duration }] });
      return;
    }
    if (!this.segmentAudioDone) {
      this.silenceRemaining = validatePause(segment.pauseAfterMs ?? 0, this.sampleRate);
      this.segmentAudioDone = true;
    }
    if (this.silenceRemaining) {
      // Silence is incremental too: a long explicit pause cannot allocate unbounded audio ahead.
      const length = Math.min(this.silenceRemaining, this.sampleRate);
      this.silenceRemaining -= length;
      this.append({ audio: { samples: new Float32Array(length), sampleRate: this.sampleRate }, startMs: this.durationMs, timeline: [] });
      return;
    }
    this.segmentIndex++;
    this.units = undefined;
    this.unitIndex = 0;
    this.segmentAudioDone = false;
    if (this.segmentIndex === this.segments.length) { this.done = true; this.completion.resolve(); this.signal(); }
  }
  private append(chunk: SpeechChunk) {
    const samples = this.sampleCount + chunk.audio.samples.length;
    if (!Number.isSafeInteger(samples)) throw new RangeError('Recording exceeds representable audio length.');
    this.chunks.push(chunk); this.sampleCount = samples; this.signal();
  }
  get audio(): AsyncIterable<SpeechChunk> {
    const job = this;
    return { async *[asyncIteratorKey]() {
      let index = 0;
      job.observed = true;
      while (true) {
        job.assertOpen();
        const chunk = job.chunks[index];
        if (chunk) { index++; yield chunk; }
        else if (job.done) return;
        else await job.changed.promise;
      }
    } };
  }
  result(): Promise<SpeechResult> {
    this.observed = true;
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    if (!this.assembly) {
      this.assembly = this.finished.then(() => {
        this.assertOpen();
        const samples = new Float32Array(this.sampleCount);
        let offset = 0;
        for (const chunk of this.chunks) { samples.set(chunk.audio.samples, offset); offset += chunk.audio.samples.length; }
        return { audio: { samples, sampleRate: this.sampleRate }, timeline: this.chunks.flatMap(chunk => chunk.timeline) };
      });
      void this.assembly.catch(() => {});
    }
    return this.assembly;
  }
  speak(options: PlaybackOptions = {}): SpeechHandle { return this.model.attach(this, { ...options }); }
  fail(error: Error) {
    if (!this.runnable) return;
    this.error = error;
    this.completion.reject(error);
    const hasPlayback = this.children.size > 0;
    queueMicrotask(() => { if (!this.observed && !hasPlayback) console.error('Wfloat generation failed:', error); });
    for (const child of [...this.children]) child.fail(error);
    this.signal();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; // Commit closure before child terminal callbacks can reenter.
    if (!this.done && !this.error) this.completion.reject(closedError());
    for (const child of [...this.children]) child.cancel();
    this.chunks.length = 0;
    this.units = undefined;
    this.assembly = undefined;
    this.signal();
    this.model.forget(this);
  }
  releaseThrough(index: number) {
    if (this.retained) return;
    while (this.baseIndex < index && this.chunks.length) { this.chunks.shift(); this.baseIndex++; }
  }
}

class Speech implements SpeechHandle {
  driver?: PlaybackDriver;
  paused = true;
  terminal = false;
  private index = 0;
  private scheduledIndex = 0;
  private position = 0;
  private started = false;
  private explicitlyPaused = false;
  private epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private detachPosition?: () => void;
  private state?: PlaybackEvent['state'];
  private highlight: SpeechHighlight | null = null;
  constructor(private model: TextToSpeechModel, readonly job: Generation, private callback: PlaybackOptions['onPlayback']) {}
  observePosition() {
    this.detachPosition = this.driver?.onPosition?.(() => {
      if (this.started && !this.terminal && !this.paused) this.tick();
    });
  }
  private get chunk() { return this.job.chunks[this.index - this.job.baseIndex]; }
  get positionMs() { return this.started ? this.driver!.positionMs() : this.position; }
  pause() {
    if (this.terminal) return;
    this.explicitlyPaused = true;
    // Even an already OS-paused speech must cancel native auto-resume intent.
    if (this.paused) { this.stop(); return; }
    this.position = this.positionMs;
    this.stop();
    this.paused = true;
    this.model.release(this);
    this.emit('paused', this.highlight);
  }
  /** OS policy already paused the native queue; preserve its auto-resume intent. */
  suspend() {
    if (this.terminal || this.paused) return;
    this.position = this.positionMs;
    this.epoch++; this.started = false; this.paused = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.scheduledIndex = this.index;
    this.model.release(this); this.emit('paused', this.highlight);
  }
  resumeFromNative() { if (!this.explicitlyPaused) this.resume(); }
  resume() { if (!this.terminal) { this.explicitlyPaused = false; this.model.activate(this); } }
  cancel() { this.finish('cancelled'); }
  fail(error: Error) { if (!this.terminal) { console.error('Wfloat speech failed:', error); this.finish('failed', error); } }
  private stop() { this.epoch++; this.driver?.stop(); this.started = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.scheduledIndex = this.index; }
  private finish(state: 'finished' | 'cancelled' | 'failed', error?: Error) {
    if (this.terminal) return;
    this.terminal = true;
    this.stop();
    this.detachPosition?.(); this.detachPosition = undefined;
    this.driver?.close();
    this.driver = undefined;
    this.job.children.delete(this);
    this.model.release(this);
    if (!this.job.retained) this.job.dispose();
    this.emit(state, null, error);
    this.callback = undefined;
  }
  private emit(state: PlaybackEvent['state'], highlight: SpeechHighlight | null, error?: Error) {
    if (this.state === state && this.highlight?.segmentIndex === highlight?.segmentIndex && this.highlight?.textStart === highlight?.textStart && this.highlight?.textEnd === highlight?.textEnd) return;
    this.state = state;
    this.highlight = highlight;
    notify(this.callback, state === 'failed' ? { state, highlight: null, error: error! } : { state, highlight });
  }
  private takeLookahead(): SpeechChunk[] {
    const chunks: SpeechChunk[] = [];
    while (true) {
      const chunk = this.job.chunks[this.scheduledIndex - this.job.baseIndex];
      if (!chunk || chunk.startMs > this.positionMs + AHEAD_MS) break;
      chunks.push(chunk);
      this.scheduledIndex++;
    }
    return chunks;
  }
  update() {
    if (this.terminal || this.paused) return;
    if (this.job.error) { this.fail(this.job.error); return; }
    if (!this.chunk) {
      if (this.job.done) this.finish('finished');
      else this.emit('buffering', null);
      return;
    }
    if (this.started) {
      try { this.driver!.append(this.takeLookahead()); } catch (error) { this.fail(asError(error)); }
      return;
    }
    if (!this.driver) return;
    const ahead = this.job.durationMs - this.positionMs;
    if (!this.job.done && ahead < this.job.startBufferMs) { this.emit('buffering', null); return; }
    const chunks = this.takeLookahead();
    const epoch = ++this.epoch;
    const starting = this.driver.start(chunks, this.position);
    this.started = true;
    void starting.then(() => {
      if (epoch !== this.epoch || this.terminal || this.paused) return;
      this.tick();
      // Native drivers advance from audio-clock events, including final drain.
      // Keep polling only for injected drivers without event support.
      if (!this.terminal && this.started && !this.driver?.onPosition) this.timer = setInterval(() => this.tick(), 20);
    }, error => { if (epoch === this.epoch && !this.terminal) this.fail(asError(error)); });
  }
  private tick() {
    if (this.terminal || this.paused) return;
    const position = this.positionMs;
    while (this.chunk && position >= this.chunk.startMs + this.chunk.audio.samples.length / this.chunk.audio.sampleRate * 1000 - 0.001) {
      this.index++;
      this.job.releaseThrough(this.index);
    }
    if (!this.chunk) {
      this.position = position;
      // An underrun is ordinary buffering, not a playback pause. Keep the native
      // queue and audio-associated lease alive so the next append can refill it
      // in background without reacquiring focus or a foreground-service lease.
      // update also finishes when production ends after the final drain event.
      this.update();
    } else {
      const timing = this.chunk.timeline.find(entry => entry.startMs <= position && entry.endMs > position);
      const highlight = timing ? { segmentIndex: timing.segmentIndex, text: timing.text, textStart: timing.textStart, textEnd: timing.textEnd } : null;
      this.emit('playing', highlight);
      this.update();
    }
    this.model.wake();
  }
}

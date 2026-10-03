import { deferred, asError, notify } from '../tts-next/internal.js';
import { snapshotPcm, StreamingResampler } from './audio.js';
import { startMicrophone, type MicrophoneCapture } from './microphone.js';
import type { SpeechToTextBackend } from './backend-types.js';
import { AudioQueue, SAMPLE_RATE, WINDOW_SAMPLES, endsInSilence, joinText, overlapText, offsetTranscript } from './transcript.js';
import { TranscriptionError, type PcmAudio, type LivePartialTranscript, type LiveTranscriptSegment,
  type LiveTranscriptUpdate, type LiveTranscriptionResult, type TranscriptionSessionOptions,
  type TranscriptionSession, type TranscriptData } from './types.js';

type CaptureFactory = typeof startMicrophone;
/** @internal All backend calls here run within the owner's exclusive session reservation. */
export class LiveSession implements TranscriptionSession {
  private completion = deferred<LiveTranscriptionResult>();
  private release = deferred<void>();
  readonly released = this.release.promise;
  private terminal = false;
  private ending = false;
  private processing = false;
  private inputCount = 0;
  private queue = new AudioQueue();
  private resampler?: StreamingResampler;
  private source?: 'external' | 'microphone';
  private capture?: MicrophoneCapture;
  private captureStart?: Promise<void>;
  private captureAbort = new AbortController();
  private captureClosing: Promise<void> = Promise.resolve();
  private segments: LiveTranscriptSegment[] = [];
  private text = '';
  private hypothesis = '';
  private lastEvent?: { text: string; id: string; final: boolean };
  private windowStart = 0;
  private decodedLength = 0;
  private windowPrefix = '';
  private overlapReference?: string;
  private utteranceData: TranscriptData = { text: '' };
  private currentData: TranscriptData = { text: '' };
  private activeSamples = 0;
  private pendingSince?: number;
  private lastPending = 0;
  private warningIssued = false;
  private monitor?: ReturnType<typeof setInterval>;
  constructor(private backend: SpeechToTextBackend, private options: TranscriptionSessionOptions,
    private done: () => void, private captureFactory: CaptureFactory = startMicrophone) {}
  result() { return this.completion.promise; }
  private snapshot(): LivePartialTranscript {
    return { text: this.text, segments: [...this.segments], ...(this.hypothesis ? { provisional: { text: this.hypothesis } } : {}) };
  }
  private stopCapture() {
    this.captureAbort.abort();
    const capture = this.capture; this.capture = undefined;
    this.captureClosing = capture?.stop().catch(error => { console.error('Wfloat microphone cleanup failed:', error); }) ?? this.captureClosing;
  }
  private end() {
    this.queue.clear(); this.resampler = undefined; this.stopCapture();
    if (this.monitor !== undefined) clearInterval(this.monitor);
    this.done();
    this.maybeRelease();
  }
  private maybeRelease() {
    if (this.terminal && !this.processing) void this.captureClosing.then(() => this.release.resolve());
  }
  cancel() {
    if (this.terminal) return;
    this.terminal = true;
    this.completion.resolve({ ...this.snapshot(), stopReason: 'cancelled' }); this.end();
  }
  fail(cause: unknown) {
    if (this.terminal) return;
    this.terminal = true;
    const error = new TranscriptionError(asError(cause).message, this.snapshot(), cause);
    this.completion.reject(error);
    notify(this.options.onError, error);
    console.error('Wfloat transcription failed:', error);
    this.end();
  }
  private checkInput() {
    if (this.terminal || this.ending) throw new Error('Transcription session no longer accepts audio.');
  }
  async push(audio: PcmAudio): Promise<void> {
    this.checkInput();
    if (this.source === 'microphone') throw new Error('Session already uses its microphone; external push would mix sources.');
    const owned = snapshotPcm(audio);
    this.source = 'external'; this.accept(owned);
  }
  private accept(audio: PcmAudio) {
    if (this.terminal || this.ending) return;
    try {
      this.resampler ??= new StreamingResampler();
      this.queue.append(this.resampler.push(audio));
      this.inputCount += audio.samples.length;
      this.checkBacklog();
      if (this.terminal) return;
      if (this.monitor === undefined) {
        this.monitor = setInterval(() => this.checkBacklog(), 1000);
        (this.monitor as unknown as { unref?: () => void }).unref?.();
      }
      this.kick();
    } catch (error) { this.fail(error); throw error; }
  }
  private checkBacklog() {
    if (this.terminal) return;
    // Offline windows retain already-decoded lookback; it is not pending work.
    const pending = this.backend.kind === 'online' ? this.queue.length + this.activeSamples : Math.max(0, this.queue.length - this.decodedLength);
    const ms = pending / SAMPLE_RATE * 1000;
    if (this.options.maxBufferedAudioMs !== undefined && ms > this.options.maxBufferedAudioMs) {
      const error = new Error(`Unprocessed audio exceeded maxBufferedAudioMs (${this.options.maxBufferedAudioMs} ms). Transcription stopped without dropping audio silently.`);
      this.fail(error); return;
    }
    const now = performance.now();
    if (ms > 4000 && this.processing) {
      this.pendingSince ??= now;
      if (!this.warningIssued && now - this.pendingSince >= 5000 && ms > this.lastPending) {
        this.warningIssued = true;
        console.warn('Wfloat transcription is falling behind incoming audio. Unprocessed audio is accumulating, increasing memory use and latency. Set maxBufferedAudioMs in createSession() to stop with a recoverable error if the backlog exceeds your application’s limit.');
      }
    } else this.pendingSince = undefined;
    this.lastPending = ms;
  }
  startMicrophone(): Promise<void> {
    try {
      this.checkInput();
      if (this.source === 'external') throw new Error('Session already uses external audio; microphone capture would mix sources.');
      if (this.captureStart) return this.captureStart;
      if (this.capture) return Promise.resolve();
      this.source = 'microphone';
      // Invoke synchronously on the user's call stack to preserve user activation.
      const starting = this.captureFactory(audio => {
        if (this.terminal || this.ending) return;
        try { this.accept(audio); } catch { /* accept has already failed the operation. */ }
      }, error => this.fail(error), this.captureAbort.signal);
      this.captureStart = starting.then(async capture => {
        if (this.terminal || this.ending) { await capture.stop(); throw new DOMException('Microphone startup cancelled', 'AbortError'); }
        this.capture = capture;
      }).catch(error => { if (!this.terminal && !this.ending) this.fail(error); throw error; });
      // Using onError alone must not cause an extra SDK-created unhandled rejection.
      void this.captureStart.catch(() => {});
      return this.captureStart;
    } catch (error) {
      if (this.source === 'microphone' && !this.terminal && !this.ending) this.fail(error);
      return Promise.reject(error);
    }
  }
  finish(): Promise<LiveTranscriptionResult> {
    if (this.terminal || this.ending) return this.result();
    this.ending = true; this.stopCapture();
    if (!this.inputCount) { this.fail(new Error('Cannot finish a transcription session without audio.')); return this.result(); }
    try { if (this.resampler) this.queue.append(this.resampler.finish()); }
    catch (error) { this.fail(error); }
    this.kick(); return this.result();
  }
  private emit(text: string, final: boolean, data: TranscriptData = { text }) {
    const id = String(this.segments.length);
    if (!text && final) return;
    if (this.lastEvent?.id === id && this.lastEvent.text === text && this.lastEvent.final === final) return;
    // Empty provisional events only retract an existing displayed hypothesis.
    if (!text && !(this.lastEvent?.id === id && !this.lastEvent.final && this.lastEvent.text)) return;
    const timed = data.segments?.filter(s => s.timing).map(s => s.timing!) ?? [];
    const words = data.words ?? (data.segments?.some(s => s.words) ? data.segments.flatMap(s => [...s.words ?? []]) : undefined);
    const event: LiveTranscriptUpdate = { id, text, isFinal: final,
      ...(timed.length ? { timing: { startMs: Math.min(...timed.map(t => t.startMs)), endMs: Math.max(...timed.map(t => t.endMs)) } } : {}),
      ...(words ? { words } : {}) };
    this.lastEvent = { id, text, final };
    if (final) {
      const { isFinal: _, ...segment } = event;
      this.segments.push(segment); this.text = joinText(this.text, text); this.hypothesis = '';
    }
    notify(this.options.onTranscript, event);
  }
  private kick() {
    if (this.processing || this.terminal) return;
    this.processing = true;
    void this.pump().catch(error => this.fail(error)).finally(() => {
      this.processing = false; this.activeSamples = 0; this.maybeRelease();
      // Input/finish can arrive after pump's last check but before this continuation.
      if (!this.terminal && (this.ending || (this.backend.kind === 'online'
        ? this.queue.length >= Math.round(SAMPLE_RATE * 0.32)
        : this.queue.length >= WINDOW_SAMPLES || (this.queue.length >= 4 * SAMPLE_RATE && this.queue.length - this.decodedLength >= 2 * SAMPLE_RATE)))) this.kick();
    });
  }
  private async pump() {
    if (this.backend.kind === 'online') await this.pumpOnline();
    else await this.pumpWindowed();
    if (this.terminal) return;
    if (this.ending && this.queue.length === 0) {
      this.terminal = true;
      this.completion.resolve({ text: this.text, segments: [...this.segments], stopReason: 'complete' }); this.end();
    }
  }
  private async pumpOnline() {
    const step = Math.round(SAMPLE_RATE * 0.32);
    while (!this.terminal && (this.queue.length >= step || this.ending)) {
      const samples = this.queue.take(Math.min(step, this.queue.length));
      const finished = this.ending && this.queue.length === 0;
      this.activeSamples = samples.length;
      const result = await this.backend.pushStream(samples, finished);
      this.activeSamples = 0;
      if (this.terminal) return;
      this.hypothesis = result.text;
      if (!result.text && this.lastEvent?.text) this.emit('', false);
      this.emit(result.text, result.isEndpoint || finished);
      if (finished) return;
      if (result.isEndpoint) await this.backend.resetStream();
    }
  }
  private async pumpWindowed() {
    const cadence = 2 * SAMPLE_RATE;
    const overlap = 3 * SAMPLE_RATE;
    while (!this.terminal && this.queue.length && (this.ending || this.queue.length >= WINDOW_SAMPLES ||
      (this.queue.length >= 4 * SAMPLE_RATE && this.queue.length - this.decodedLength >= cadence))) {
      const length = Math.min(this.queue.length, WINDOW_SAMPLES);
      if (this.ending && this.queue.length === this.decodedLength) {
        // Remaining samples are already-decoded context, not new input. Do not
        // rerun a full window merely to mark its existing hypothesis final.
        if (!this.hypothesis && this.lastEvent?.text) this.emit('', false);
        this.emit(this.hypothesis, true, this.currentData);
        this.queue.clear(); this.hypothesis = ''; return;
      }
      const samples = this.queue.peek(length);
      if (this.windowPrefix && this.overlapReference === undefined) {
        // Compute this only if new audio actually needs another window decode.
        const reference = await this.backend.decode(samples.slice(0, overlap));
        if (this.terminal) return;
        this.overlapReference = reference.text;
      }
      const data = offsetTranscript(await this.backend.decode(samples), this.windowStart / SAMPLE_RATE * 1000);
      if (this.terminal) return;
      this.decodedLength = length;
      this.hypothesis = overlapText(this.windowPrefix, data.text, this.overlapReference ?? '').text;
      this.currentData = this.mergeWindowData(data);
      const final = (this.ending && this.queue.length === length) || endsInSilence(samples);
      if (final) {
        if (!this.hypothesis && this.lastEvent?.text) this.emit('', false);
        this.emit(this.hypothesis, true, this.mergeWindowData(data));
        this.queue.discard(length); this.windowStart += length;
        this.decodedLength = 0; this.windowPrefix = ''; this.overlapReference = undefined; this.utteranceData = { text: '' }; this.currentData = { text: '' };
        this.hypothesis = '';
      } else {
        this.emit(this.hypothesis, false, this.mergeWindowData(data));
        if (length === WINDOW_SAMPLES) {
          // A subsequent window will recognize the retained overlap separately.
          this.overlapReference = undefined;
          this.windowPrefix = this.hypothesis;
          this.utteranceData = this.currentData;
          const consumed = length - overlap;
          this.queue.discard(consumed); this.windowStart += consumed; this.decodedLength = overlap;
        } else break;
      }
    }
  }
  private mergeWindowData(data: TranscriptData): TranscriptData {
    // Retain real timing spans only. Suppress already represented overlap metadata
    // by its absolute audio time, independently of text boundary reconciliation.
    const prior = this.utteranceData;
    const segments = [...prior.segments ?? []];
    const end = segments.reduce((value, s) => Math.max(value, s.timing?.endMs ?? 0), 0);
    for (const s of data.segments ?? []) if (!s.timing || s.timing.endMs > end) segments.push(s);
    const words = [...prior.words ?? []];
    const wordEnd = words.reduce((value, w) => Math.max(value, w.timing?.endMs ?? 0), 0);
    for (const w of data.words ?? []) if (!w.timing || w.timing.endMs > wordEnd) words.push(w);
    return { text: this.hypothesis, ...(segments.length ? { segments } : {}), ...(words.length ? { words } : {}) };
  }
}

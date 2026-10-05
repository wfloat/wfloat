import type { MicrophoneOptions } from '../audio-next/microphone';
import { deferred, asError, notify } from '../tts-next/internal';
import { snapshotPcm, StreamingResampler } from '../stt-next/audio';
import { AudioQueue } from '../stt-next/transcript';
import { startMicrophone, type MicrophoneCapture as OwnedCapture } from '../stt-next/microphone';
import { attachCapture, type MicrophoneCapture } from '../audio-next/microphone';
import type { PcmAudio } from '../stt-next/types';
import type { VadBackend } from './backend-types';
import { Segmenter, type Config } from './segmenter';
import { VadError, type DetectionResult, type VadSessionResult } from './types';
/** Internal operation; the model owns exclusive backend scheduling. */
export class VadOperation {
  private completion = deferred<DetectionResult<boolean>>();
  private release = deferred<void>();
  readonly released = this.release.promise;
  private terminal = false;
  private ending = false;
  private finishing = false;
  private ready = false;
  private processing = false;
  private queue = new AudioQueue();
  private resampler = new StreamingResampler();
  private segmenter: Segmenter;
  private source?: 'external' | 'owned' | 'shared';
  private capture?: OwnedCapture;
  private captureStart?: Promise<void>;
  private captureAbort = new AbortController();
  private detached?: () => void;
  private closing = Promise.resolve();
  private warningSince?: number;
  private warned = false;
  constructor(private backend: VadBackend, private config: Config, private file: boolean,
    private done: () => void, private captureFactory: typeof startMicrophone = startMicrophone) { this.segmenter = new Segmenter(config, file, backend.sampleRate); }
  get active() { return !this.terminal; }
  result() { return this.completion.promise; }
  private stopCapture() {
    this.detached?.(); this.detached = undefined;
    this.captureAbort.abort();
    const capture = this.capture; this.capture = undefined;
    if (capture) this.closing = capture.stop().catch(error => console.error('Wfloat microphone cleanup failed:', error));
  }
  private releaseIfDone() {
    if (this.terminal && !this.processing) void this.closing.then(() => this.release.resolve());
  }
  private end() {
    this.queue.clear(); this.segmenter.clear(); this.resampler = new StreamingResampler();
    this.stopCapture(); this.done(); this.releaseIfDone();
  }
  cancel() {
    if (this.terminal) return;
    this.terminal = true; this.segmenter.cancelNotifications();
    this.completion.resolve({ ...this.segmenter.snapshot(), stopReason: 'cancelled' }); this.end();
  }
  fail(cause: unknown) {
    if (this.terminal) return;
    this.terminal = true; this.segmenter.cancelNotifications();
    const error = new VadError(asError(cause).message, this.segmenter.snapshot(), cause);
    this.completion.reject(error);
    if (!this.file) notify(this.config.onError, error);
    console.error('Wfloat voice activity detection failed:', error);
    this.end();
  }
  private checkInput() { if (this.terminal || this.finishing || this.ending) throw new Error('VAD operation no longer accepts audio.'); }
  async push(audio: PcmAudio): Promise<void> {
    this.checkInput();
    if (this.source && this.source !== 'external') throw new Error('VAD session already has a microphone source.');
    const owned = snapshotPcm(audio); this.source = 'external'; this.accept(owned);
  }
  private accept(audio: PcmAudio) {
    if (this.terminal || this.ending) return;
    try {
      this.queue.append(this.resampler.push(audio));
      const now = performance.now();
      if (this.queue.length > this.backend.sampleRate * 4) {
        this.warningSince ??= now;
        if (!this.warned && now - this.warningSince > 5000) {
          this.warned = true;
          console.warn('Wfloat VAD is falling behind incoming audio. Pending audio increases memory use and latency. Stop the source and finish(), or cancel() to discard pending work.');
        }
      } else this.warningSince = undefined;
      this.kick();
    } catch (error) { this.fail(error); }
  }
  async attachMicrophone(source: MicrophoneCapture): Promise<void> {
    this.checkInput();
    if (this.source) throw new Error('VAD session already has an audio source.');
    const detach = attachCapture(source, audio => this.accept(audio), error => this.fail(error));
    this.detached = detach; this.source = 'shared';
  }
  startMicrophone(options?: MicrophoneOptions): Promise<void> {
    try {
      this.checkInput();
      if (this.source && this.source !== 'owned') throw new Error('VAD session already has an audio source.');
      if (this.captureStart) return this.captureStart;
      if (this.capture) return this.capture.start().catch(error => { this.fail(error); throw error; });
      this.source = 'owned';
      // Acquire once; resume keeps the original native capture policy.
      this.captureStart = this.captureFactory(audio => this.accept(audio), error => this.fail(error), this.captureAbort.signal, options).then(async capture => {
        if (this.terminal || this.ending) { await capture.stop(); throw Object.assign(new Error('Microphone startup cancelled'), { name: 'AbortError' }); }
        this.capture = capture;
        this.captureStart = undefined;
      }).catch(error => { if (!this.terminal && !this.ending) this.fail(error); throw error; });
      void this.captureStart.catch(() => {});
      return this.captureStart;
    } catch (error) { return Promise.reject(error); }
  }
  finish(): Promise<VadSessionResult> {
    if (this.terminal || this.finishing || this.ending) return this.result();
    this.finishing = true;
    const capture = this.capture;
    if (capture) {
      // Block new public input now, but accept owned capture's stop-time PCM
      // until native stop fences delivery. Flush resampling only afterward.
      this.capture = undefined;
      const stopped = Promise.resolve().then(() => capture.stop());
      this.closing = stopped.catch(() => {});
      void stopped.then(() => this.finishInput(), error => this.fail(error));
    } else {
      // Shared sources detach only this consumer; pending acquisition is aborted.
      this.stopCapture(); this.finishInput();
    }
    return this.result();
  }
  private finishInput() {
    if (this.terminal) return;
    this.ending = true;
    try { this.queue.append(this.resampler.finish()); } catch (error) { this.fail(error); }
    this.kick();
  }
  begin() { this.ready = true; this.kick(); }
  private kick() {
    if (!this.ready || this.terminal || this.processing) return;
    this.processing = true;
    void this.pump().catch(error => this.fail(error)).finally(() => {
      this.processing = false; this.releaseIfDone();
      if (!this.terminal && (this.queue.length >= this.backend.frameSize || this.ending)) this.kick();
    });
  }
  private async pump() {
    while (!this.terminal && (this.queue.length >= this.backend.frameSize || (this.ending && this.queue.length))) {
      const samples = this.queue.take(this.backend.frameSize);
      const frame = samples.length === this.backend.frameSize ? samples : new Float32Array(this.backend.frameSize);
      if (frame !== samples) frame.set(samples);
      const score = await this.backend.score(frame);
      if (this.terminal) return;
      // Zero padding only satisfies inference geometry; public time stops at real input.
      this.segmenter.feed(samples, score);
    }
    if (this.ending && !this.terminal && !this.queue.length) {
      this.segmenter.finish();
      this.terminal = true;
      this.completion.resolve({ ...this.segmenter.snapshot(), stopReason: 'complete' }); this.end();
    }
  }
}

// AudioPlayer.ts
// HTTP-safe fallback streaming mono PCM player (Float32Array chunks).
// No AudioWorklet, no SharedArrayBuffer.
// Never drops unplayed audio.
// Supports: play/pause/clear, “start gate” (delay scheduling until shouldStart),
// underrun => silence (nothing scheduled), seamless when chunks arrive in time.

export type AudioPlayerOptions = {
  /** Sample rate of incoming chunks (your worker output). */
  inputSampleRate?: number; // default 22050

  /** Sample rate hint for AudioContext; browser may ignore and pick hardware rate. */
  contextSampleRateHint?: number; // default 22050

  /** Keep this much audio scheduled into the future (seconds). */
  scheduleAheadSec?: number; // default 0.5

  /** Scheduler tick interval (ms). */
  tickMs?: number; // default 50

  /** Small cushion so we don’t schedule “in the past”. */
  safetySec?: number; // default 0.02

  /** Fade time for pause/resume to reduce clicks. */
  rampSec?: number;

  /**
   * Start-gate initial state:
   * - true  => normal behavior (schedules as soon as you play)
   * - false => won’t schedule until you call setStartGateOpen(true)
   */
  startGateInitiallyOpen?: boolean; // default true
};

function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const t = i / ratio;
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = t - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function holdAudioParamAtTime(param: AudioParam, t: number): void {
  const withHold = param as AudioParam & { cancelAndHoldAtTime?: (cancelTime: number) => void };
  if (typeof withHold.cancelAndHoldAtTime === "function") {
    withHold.cancelAndHoldAtTime(t);
    return;
  }

  // Fallback for browsers without cancelAndHoldAtTime().
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
}

function createSilentWavBlobUrl(durationSec = 1, sampleRate = 8000): string {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = frameCount * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  // Data bytes are already zeroed => silence.

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

export class AudioPlayer {
  private static silentMediaUrl: string | null = null;

  private readonly inputSampleRate: number;
  private readonly scheduleAheadSec: number;
  private readonly tickMs: number;
  private readonly safetySec: number;
  private readonly rampSec: number;

  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly silentMediaEl: HTMLAudioElement;

  // Not-yet-scheduled audio
  private queue: Array<{ buffer: AudioBuffer; onStart?: (() => void) | undefined }> = [];
  private queuedSec = 0;

  // Sources already scheduled (so clear() can stop them)
  private scheduled = new Set<AudioBufferSourceNode>();
  private pendingChunkStartCallbacks: Array<{ startTime: number; callback: () => void }> = [];
  private activeChunkStartCallback: (() => void) | null = null;
  private onFinishedPlayingCallback: (() => void) | null = null;
  private hasUnfinishedAudioInternal = false;
  private generationComplete = false;

  // Next scheduled start time in AudioContext time
  private nextTime = 0;

  private timer: number | null = null;
  private disposed = false;

  // User intent: true if user wants playback (i.e., not paused)
  private playRequested = false;
  // Tracks an explicit user pause separately from the initial "not yet played" state.
  private pausedByUserExplicitly = false;

  // Gate: when false, we do NOT schedule any audio (useful for your tRuntime/tPlayAudio logic)
  private startGateOpen: boolean;
  private locked = false;

  constructor(opts: AudioPlayerOptions = {}) {
    this.inputSampleRate = opts.inputSampleRate ?? 22050;
    this.scheduleAheadSec = opts.scheduleAheadSec ?? 0.5;
    this.tickMs = opts.tickMs ?? 50;
    this.safetySec = opts.safetySec ?? 0.02;
    this.rampSec = opts.rampSec ?? 0.03;
    this.startGateOpen = opts.startGateInitiallyOpen ?? true;

    this.ctx = new AudioContext({
      sampleRate: opts.contextSampleRateHint ?? this.inputSampleRate,
      latencyHint: "interactive",
    });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.ctx.destination);

    this.silentMediaEl = this.createSilentMediaElement();
    this.configurePlaybackAudioSession();

    // Start paused
    void this.ctx.suspend();
    this.nextTime = this.ctx.currentTime + this.safetySec;

    this.startScheduler();
  }

  /** True only when user wants play AND the context is running AND the gate is open. */
  get isPlaying(): boolean {
    return !this.locked && this.playRequested && this.startGateOpen && this.ctx.state === "running";
  }

  /** True if the user has paused (so your code can avoid auto-starting). */
  get isPausedByUser(): boolean {
    return this.pausedByUserExplicitly;
  }

  get isStartGateOpen(): boolean {
    return this.startGateOpen;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get hasUnfinishedAudio(): boolean {
    return this.hasUnfinishedAudioInternal;
  }

  /**
   * If user pressed Play but gate is closed (waiting for shouldStart),
   * state is "waiting" instead of "playing".
   */
  get state(): "paused" | "waiting" | "playing" | "locked" {
    if (this.locked) return "locked";
    if (!this.playRequested) return "paused";
    return this.startGateOpen ? "playing" : "waiting";
  }

  /** How many seconds of audio are buffered (queued + already scheduled ahead). */
  getBufferedSeconds(): number {
    const now = this.ctx.currentTime;
    const scheduledAhead = Math.max(0, this.nextTime - now);
    return scheduledAhead + this.queuedSec;
  }

  /** Enqueue a mono chunk (sequential). */
  enqueue(
    samples: Float32Array,
    sampleRate = this.inputSampleRate,
    onStart?: () => void,
  ): void {
    if (this.disposed) throw new Error("AudioPlayer is disposed");
    if (samples.length === 0) return;

    const pcm = resampleLinear(samples, sampleRate, this.ctx.sampleRate);

    const buf = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    buf.copyToChannel(pcm as any, 0);

    this.queue.push({ buffer: buf, onStart });
    this.queuedSec += buf.duration;
    this.hasUnfinishedAudioInternal = true;
  }

  /** Enqueue a silent chunk for the given duration in seconds. */
  enqueueSilence(durationSec: number, sampleRate = this.inputSampleRate): void {
    if (this.disposed) throw new Error("AudioPlayer is disposed");
    if (durationSec <= 0) return;

    const frameCount = Math.max(1, Math.round(durationSec * sampleRate));
    this.enqueue(new Float32Array(frameCount), sampleRate);
  }

  /**
   * Optional helper if you receive a transferred ArrayBuffer + known length.
   * If you send Float32Array directly (recommended), you don't need this.
   */
  enqueueTransferred(buffer: ArrayBuffer, length: number, sampleRate = this.inputSampleRate): void {
    const view = new Float32Array(buffer, 0, length);
    this.enqueue(view, sampleRate);
  }

  /**
   * Open/close the “start gate”.
   * - While closed: nothing schedules, so audio does NOT get consumed.
   * - When opened: we re-anchor nextTime to "now + safety" and start scheduling.
   */
  setStartGateOpen(open: boolean): void {
    if (this.disposed) return;

    const wasOpen = this.startGateOpen;
    this.startGateOpen = open;

    if (!wasOpen && open) {
      // Start scheduling from "now" so we don't have a big silent gap from old nextTime.
      this.nextTime = this.ctx.currentTime + this.safetySec;
    }

    if (wasOpen !== open) {
      this.notifyActiveChunkStateChanged();
    }
  }

  /** Convenience: call this each chunk with your shouldStart boolean. */
  updateShouldStart(shouldStart: boolean): void {
    // Only opens (never auto-closes) unless you explicitly want to close it.
    if (shouldStart) this.setStartGateOpen(true);
  }

  /**
   * Start/resume playback. Must be called from a user gesture in many browsers.
   * Idempotent: safe to call multiple times.
   */
  async play(): Promise<void> {
    if (this.disposed) throw new Error("AudioPlayer is disposed");
    if (this.locked) return;

    this.playRequested = true;
    this.pausedByUserExplicitly = false;

    this.configurePlaybackAudioSession();
    await this.startSilentMediaKeepalive();

    const t = this.ctx.currentTime;

    // If already running, nothing else needed.
    if (this.ctx.state === "running") {
      holdAudioParamAtTime(this.gain.gain, t);
      this.gain.gain.setValueAtTime(this.gain.gain.value, t);
      this.gain.gain.linearRampToValueAtTime(1, t + this.rampSec);
      this.notifyActiveChunkStateChanged();
      return;
    }

    // Fade-in (when we actually resume)
    holdAudioParamAtTime(this.gain.gain, t);
    this.gain.gain.setValueAtTime(0, t);
    this.gain.gain.linearRampToValueAtTime(1, t + this.rampSec);

    await this.ctx.resume();
    this.notifyActiveChunkStateChanged();
  }

  /**
   * Best-effort user-gesture priming for strict mobile autoplay policies.
   * Call this synchronously at the beginning of a click/tap-initiated flow
   * before any awaited work (for example at the top of generate()).
   */
  primeForUserGesture(): void {
    if (this.disposed) return;

    this.configurePlaybackAudioSession();

    void this.startSilentMediaKeepalive();

    if (this.ctx.state !== "running") {
      void this.ctx.resume().catch((error) => {
        console.warn("AudioPlayer user-gesture prime resume() failed:", error);
      });
    }
  }

  async lock(): Promise<void> {
    if (this.disposed) return;
    this.locked = true;
    this.notifyActiveChunkStateChanged();
  }

  unlock(): void {
    if (this.disposed) return;
    if (!this.locked) return;
    this.locked = false;
    this.notifyActiveChunkStateChanged();
  }

  /**
   * Pause without consuming buffered audio; resume continues at the correct sample.
   * Idempotent: safe to call multiple times.
   */
  async pause(): Promise<void> {
    if (this.disposed) return;
    this.pausedByUserExplicitly = true;
    if (!this.playRequested) return;

    this.playRequested = false;
    this.notifyActiveChunkStateChanged();

    if (this.ctx.state !== "running") {
      this.stopSilentMediaKeepalive();
      return;
    }

    // Fade-out then suspend (reduces click)
    const t = this.ctx.currentTime;
    const fadeEnd = t + this.rampSec;
    holdAudioParamAtTime(this.gain.gain, t);
    this.gain.gain.linearRampToValueAtTime(0, fadeEnd);

    // Give the render thread a tiny cushion so suspend() doesn't cut the ramp mid-sample.
    await sleep(Math.ceil((this.rampSec + 0.005) * 1000));
    holdAudioParamAtTime(this.gain.gain, this.ctx.currentTime);
    this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    await this.ctx.suspend();
    this.stopSilentMediaKeepalive();
  }

  /**
   * Prepare player state for a brand-new generation.
   * Drops queued/scheduled audio, clears any prior user-pause latch, and leaves the player in a
   * waiting-to-autoplay state so the next generation can become audible as soon as the start gate opens.
   */
  async resetForNewGeneration(): Promise<void> {
    if (this.disposed) return;

    this.playRequested = true;
    this.pausedByUserExplicitly = false;
    this.generationComplete = false;
    this.onFinishedPlayingCallback = null;
    this.setStartGateOpen(false);
    this.clear();
  }

  /**
   * Drop all queued + scheduled audio and reset timeline.
   * Does NOT change user intent (playRequested) or gate state.
   */
  clear(): void {
    if (this.disposed) return;

    for (const s of this.scheduled) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    this.scheduled.clear();

    this.queue.length = 0;
    this.queuedSec = 0;
    this.pendingChunkStartCallbacks.length = 0;
    this.activeChunkStartCallback = null;
    this.hasUnfinishedAudioInternal = false;

    this.nextTime = this.ctx.currentTime + this.safetySec;
  }

  setOnFinishedPlayingCallback(callback: (() => void) | null): void {
    this.onFinishedPlayingCallback = callback;
  }

  markGenerationComplete(): void {
    this.generationComplete = true;
    this.maybeEmitFinishedPlaying();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;

    this.clear();
    this.stopSilentMediaKeepalive();
    await this.ctx.close();
  }

  // ---- internal scheduling loop ----

  private startScheduler(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    if (this.disposed) return;
    this.flushStartedChunkCallbacks();

    // Do not schedule unless:
    // - user wants play, and
    // - start gate is open
    if (this.locked || !this.playRequested || !this.startGateOpen) return;

    const now = this.ctx.currentTime;

    // If we underrun or got reset, re-anchor.
    if (this.nextTime < now + this.safetySec) {
      this.nextTime = now + this.safetySec;
    }

    const horizon = now + this.scheduleAheadSec;

    while (this.nextTime < horizon && this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      this.queuedSec -= chunk.buffer.duration;
      this.scheduleBuffer(chunk.buffer, chunk.onStart);
    }

    // If queue is empty, we schedule nothing => silence until more chunks arrive.
  }

  private scheduleBuffer(buf: AudioBuffer, onStart?: () => void): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    this.scheduled.add(src);
    src.onended = () => {
      this.scheduled.delete(src);
      this.maybeEmitFinishedPlaying();
    };

    const startTime = this.nextTime;
    src.start(startTime);
    if (onStart) {
      this.pendingChunkStartCallbacks.push({ startTime, callback: onStart });
    }
    this.nextTime += buf.duration;
  }

  private flushStartedChunkCallbacks(): void {
    if (this.pendingChunkStartCallbacks.length === 0) return;

    const now = this.ctx.currentTime;
    const epsilonSec = 0.005;

    while (
      this.pendingChunkStartCallbacks.length > 0 &&
      this.pendingChunkStartCallbacks[0].startTime <= now + epsilonSec
    ) {
      const pending = this.pendingChunkStartCallbacks.shift()!;
      this.activeChunkStartCallback = pending.callback;
      pending.callback();
    }
  }

  private notifyActiveChunkStateChanged(): void {
    this.activeChunkStartCallback?.();
  }

  private maybeEmitFinishedPlaying(): void {
    if (!this.generationComplete) return;
    if (this.queue.length > 0 || this.scheduled.size > 0) return;
    this.hasUnfinishedAudioInternal = false;
    const callback = this.onFinishedPlayingCallback;
    this.onFinishedPlayingCallback = null;
    this.generationComplete = false;
    callback?.();
  }

  private createSilentMediaElement(): HTMLAudioElement {
    if (!AudioPlayer.silentMediaUrl) {
      AudioPlayer.silentMediaUrl = createSilentWavBlobUrl();
    }

    const el = new Audio();
    el.src = AudioPlayer.silentMediaUrl;
    el.loop = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.setAttribute("x-webkit-airplay", "deny");

    try {
      (el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    } catch {
      // ignore
    }

    return el;
  }

  private configurePlaybackAudioSession(): void {
    try {
      const nav = navigator as Navigator & {
        audioSession?: {
          type: string;
        };
      };
      if (nav.audioSession) {
        nav.audioSession.type = "playback";
      }
    } catch {
      // Experimental API; ignore on unsupported browsers.
    }
  }

  private async startSilentMediaKeepalive(): Promise<void> {
    try {
      if (!this.silentMediaEl.paused) return;
      this.silentMediaEl.currentTime = 0;
      await this.silentMediaEl.play();
    } catch (error) {
      console.warn("AudioPlayer silent media keepalive play() failed:", error);
      // Best-effort iOS workaround. AudioContext resume() is still the primary path.
    }
  }

  private stopSilentMediaKeepalive(): void {
    try {
      this.silentMediaEl.pause();
      this.silentMediaEl.currentTime = 0;
    } catch {
      // ignore
    }
  }
}

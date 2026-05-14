import { AudioPlayer } from "../speech/audioPlayer.js";
import { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from "./catalog.js";
import { getPersistentId, setPersistentId } from "../util/persistentIdStorage.js";
import { TtsWorkerBridge } from "../worker/ttsWorkerBridge.js";
import type {
  LoadModelProgressEvent,
  LoadTtsModelOptions,
  TimelineChunk,
  TtsDialogueOptions,
  TtsEmotion,
  TtsProgressEvent,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from "./types.js";

const DEFAULT_EMOTION: TtsEmotion = "neutral";
const DEFAULT_INTENSITY = 0.5;
const DEFAULT_SPEED = 1.0;
const DEFAULT_SILENCE_PADDING_SEC = 0.1;
const DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC = 0.2;
const SAMPLE_RATE_FALLBACK = 22050;

type ActiveRun = {
  token: number;
  reject: (reason?: unknown) => void;
};

type NormalizedSynthesizeOptions = {
  text: string;
  voice: string | number | undefined;
  sid: number;
  emotion: TtsEmotion;
  intensity: number;
  speed: number;
  silencePaddingSec: number;
  autoPlay: boolean;
  onProgress?: (event: TtsProgressEvent) => void;
  onFinishedPlaying?: () => void;
};

type NormalizedDialogueSegment = {
  text: string;
  voice: string | number | undefined;
  sid: number;
  emotion: TtsEmotion;
  intensity: number;
  speed: number;
  sentenceSilencePaddingSec: number;
};

type NormalizedDialogueOptions = {
  segments: NormalizedDialogueSegment[];
  silenceBetweenSegmentsSec: number;
  autoPlay: boolean;
  onProgress?: (event: TtsProgressEvent) => void;
  onFinishedPlaying?: () => void;
};

type BuildResultState = {
  samples: number[];
  timeline: TimelineChunk[];
  cumulativeSamples: number;
};

function appendSamples(target: number[], source: Float32Array): void {
  for (let i = 0; i < source.length; i += 1) {
    target.push(source[i]);
  }
}

function appendSilence(
  state: BuildResultState,
  sampleRate: number,
  silencePaddingSec: number,
): void {
  if (sampleRate <= 0 || silencePaddingSec <= 0) {
    return;
  }

  const silenceSamples = Math.max(0, Math.round(silencePaddingSec * sampleRate));
  for (let i = 0; i < silenceSamples; i += 1) {
    state.samples.push(0);
  }
  state.cumulativeSamples += silenceSamples;
}

function buildAudioDurationSec(samples: number, sampleRate: number): number {
  if (sampleRate <= 0) {
    return 0;
  }
  return samples / sampleRate;
}

function normalizeEmotion(value: unknown): TtsEmotion {
  return VALID_EMOTIONS.includes(value as TtsEmotion) ? (value as TtsEmotion) : DEFAULT_EMOTION;
}

function normalizeIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INTENSITY;
  }
  return Math.min(Math.max(value, 0), 1);
}

function normalizeSpeed(value: unknown, defaultValue = DEFAULT_SPEED): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return value;
}

function normalizeNonNegative(value: unknown, defaultValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(value, 0);
}

function normalizeVoiceId(voice: string | number | undefined): number {
  if (typeof voice === "number") {
    if (!Number.isInteger(voice) || !VALID_SIDS.includes(voice)) {
      throw new Error(`Invalid numeric voice: ${voice}`);
    }
    return voice;
  }

  if (typeof voice === "string") {
    const trimmed = voice.trim();
    if (!trimmed) {
      return 0;
    }
    const sid = SPEAKER_IDS[trimmed];
    if (sid === undefined) {
      throw new Error(`Invalid string voice: ${trimmed}`);
    }
    return sid;
  }

  return 0;
}

function computeDialogueSegmentOffsets(segments: Array<{ text: string }>): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i += 1) {
    offsets.push(cursor);
    cursor += segments[i].text.length;
    if (i + 1 < segments.length) {
      cursor += 1;
    }
  }
  return offsets;
}

export class TtsModel {
  private activeRun: ActiveRun | null = null;
  private nextRunToken = 1;

  private constructor(
    public readonly modelId: string,
    public readonly sampleRate: number,
    private readonly player: AudioPlayer,
  ) {}

  static async load(modelId: string, options: LoadTtsModelOptions = {}): Promise<TtsModel> {
    const cachedPersistentId = getPersistentId();
    const response = await TtsWorkerBridge.loadModel(
      modelId,
      cachedPersistentId ?? undefined,
      (message) => {
        options.onProgress?.(message.event as LoadModelProgressEvent);
      },
    );

    setPersistentId(response.persistentId);

    options.onProgress?.({ status: "completed" });

    return new TtsModel(
      modelId,
      response.sampleRate || SAMPLE_RATE_FALLBACK,
      new AudioPlayer({
        inputSampleRate: response.sampleRate || SAMPLE_RATE_FALLBACK,
        scheduleAheadSec: 0.5,
        tickMs: 50,
      }),
    );
  }

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
    const normalized = this.normalizeSynthesizeOptions(options);
    await this.interruptActiveRun("TTS request interrupted by a new request.");

    this.player.primeForUserGesture();
    await this.player.lock();

    try {
      await this.player.resetForNewGeneration();
      this.player.setOnFinishedPlayingCallback(normalized.onFinishedPlaying ?? null);

      if (!normalized.autoPlay) {
        await this.player.pause();
      }

      const resultState: BuildResultState = {
        samples: [],
        timeline: [],
        cumulativeSamples: 0,
      };

      const runToken = this.nextRunToken;
      this.nextRunToken += 1;

      const promise = new Promise<TtsSynthesisResult>(async (resolve, reject) => {
        this.activeRun = { token: runToken, reject };

        try {
          this.player.unlock();

          await TtsWorkerBridge.generate(
            {
              text: normalized.text,
              voiceId: normalized.voice,
              emotion: normalized.emotion,
              intensity: normalized.intensity,
              speed: normalized.speed,
              silencePaddingSec: normalized.silencePaddingSec,
            },
            (message) => {
              if (this.activeRun?.token !== runToken) {
                return;
              }

              const chunkStartSec = buildAudioDurationSec(
                resultState.cumulativeSamples,
                this.sampleRate,
              );
              appendSamples(resultState.samples, message.samples);
              resultState.cumulativeSamples += message.samples.length;
              const chunkEndSec = buildAudioDurationSec(
                resultState.cumulativeSamples,
                this.sampleRate,
              );

              resultState.timeline.push({
                index: resultState.timeline.length,
                text: message.text,
                highlightStart: message.highlightStart,
                highlightEnd: message.highlightEnd,
                startSec: chunkStartSec,
                endSec: chunkEndSec,
                durationSec: chunkEndSec - chunkStartSec,
                progress: message.progress,
                voice: normalized.voice,
              });

              const progressEvent: TtsProgressEvent = {
                progress: message.progress,
                isPlaying: this.player.isPlaying,
                textHighlightStart: message.highlightStart,
                textHighlightEnd: message.highlightEnd,
                text: message.text,
              };

              this.player.enqueue(message.samples, this.sampleRate, () => {
                normalized.onProgress?.({
                  ...progressEvent,
                  isPlaying: this.player.isPlaying,
                });
              });

              if (message.progress < 1 && message.silencePaddingSec > 0) {
                this.player.enqueueSilence(message.silencePaddingSec, this.sampleRate);
                appendSilence(resultState, this.sampleRate, message.silencePaddingSec);
              }

              const shouldStart =
                message.progress >= 1 || message.tRuntime >= message.tPlayAudio;
              if (shouldStart && !this.player.isStartGateOpen) {
                this.player.setStartGateOpen(true);
                if (!this.player.isPausedByUser) {
                  void this.player.play();
                }
              }

              if (!normalized.autoPlay && !this.player.isPausedByUser) {
                void this.player.pause();
              }

              if (!normalized.autoPlay) {
                normalized.onProgress?.(progressEvent);
              }
            },
          );

          if (this.activeRun?.token === runToken) {
            this.activeRun = null;
          }

          this.player.markGenerationComplete();

          const durationSec = buildAudioDurationSec(resultState.samples.length, this.sampleRate);
          resolve({
            audio: {
              samples: Float32Array.from(resultState.samples),
              sampleRate: this.sampleRate,
              durationSec,
            },
            timeline: {
              chunks: resultState.timeline,
              durationSec,
            },
            modelId: this.modelId,
            text: normalized.text,
          });
        } catch (error) {
          if (this.activeRun?.token === runToken) {
            this.activeRun = null;
          }
          reject(error);
        }
      });

      return await promise;
    } finally {
      this.player.unlock();
    }
  }

  async synthesizeDialogue(options: TtsDialogueOptions): Promise<TtsSynthesisResult> {
    const normalized = this.normalizeDialogueOptions(options);
    await this.interruptActiveRun("TTS request interrupted by a new request.");

    this.player.primeForUserGesture();
    await this.player.lock();

    try {
      await this.player.resetForNewGeneration();
      this.player.setOnFinishedPlayingCallback(normalized.onFinishedPlaying ?? null);

      if (!normalized.autoPlay) {
        await this.player.pause();
      }

      const resultState: BuildResultState = {
        samples: [],
        timeline: [],
        cumulativeSamples: 0,
      };
      const fullText = normalized.segments.map((segment) => segment.text).join(" ");
      const segmentOffsets = computeDialogueSegmentOffsets(normalized.segments);

      const runToken = this.nextRunToken;
      this.nextRunToken += 1;

      const promise = new Promise<TtsSynthesisResult>(async (resolve, reject) => {
        this.activeRun = { token: runToken, reject };

        try {
          this.player.unlock();

          await TtsWorkerBridge.generateDialogue(
            {
              segments: normalized.segments.map((segment) => ({
                text: segment.text,
                voiceId: segment.voice,
                emotion: segment.emotion,
                intensity: segment.intensity,
                speed: segment.speed,
                sentenceSilencePaddingSec: segment.sentenceSilencePaddingSec,
              })),
              speed: undefined,
              silenceBetweenSegmentsSec: normalized.silenceBetweenSegmentsSec,
            },
            (message) => {
              if (this.activeRun?.token !== runToken) {
                return;
              }

              const segmentIndex =
                typeof message.textHighlightSegment === "number"
                  ? message.textHighlightSegment
                  : undefined;
              const segmentOffset =
                segmentIndex !== undefined ? segmentOffsets[segmentIndex] ?? 0 : 0;
              const highlightStart = segmentOffset + message.highlightStart;
              const highlightEnd = segmentOffset + message.highlightEnd;
              const voice =
                segmentIndex !== undefined ? normalized.segments[segmentIndex]?.voice : undefined;

              const chunkStartSec = buildAudioDurationSec(
                resultState.cumulativeSamples,
                this.sampleRate,
              );
              appendSamples(resultState.samples, message.samples);
              resultState.cumulativeSamples += message.samples.length;
              const chunkEndSec = buildAudioDurationSec(
                resultState.cumulativeSamples,
                this.sampleRate,
              );

              resultState.timeline.push({
                index: resultState.timeline.length,
                text: message.text,
                highlightStart,
                highlightEnd,
                startSec: chunkStartSec,
                endSec: chunkEndSec,
                durationSec: chunkEndSec - chunkStartSec,
                progress: message.progress,
                voice,
                segmentIndex,
              });

              const progressEvent: TtsProgressEvent = {
                progress: message.progress,
                isPlaying: this.player.isPlaying,
                textHighlightStart: highlightStart,
                textHighlightEnd: highlightEnd,
                text: message.text,
                ...(segmentIndex !== undefined
                  ? { textHighlightSegment: segmentIndex }
                  : {}),
              };

              this.player.enqueue(message.samples, this.sampleRate, () => {
                normalized.onProgress?.({
                  ...progressEvent,
                  isPlaying: this.player.isPlaying,
                });
              });

              if (message.progress < 1 && message.silencePaddingSec > 0) {
                this.player.enqueueSilence(message.silencePaddingSec, this.sampleRate);
                appendSilence(resultState, this.sampleRate, message.silencePaddingSec);
              }

              const shouldStart =
                message.progress >= 1 || message.tRuntime >= message.tPlayAudio;
              if (shouldStart && !this.player.isStartGateOpen) {
                this.player.setStartGateOpen(true);
                if (!this.player.isPausedByUser) {
                  void this.player.play();
                }
              }

              if (!normalized.autoPlay && !this.player.isPausedByUser) {
                void this.player.pause();
              }

              if (!normalized.autoPlay) {
                normalized.onProgress?.(progressEvent);
              }
            },
          );

          if (this.activeRun?.token === runToken) {
            this.activeRun = null;
          }

          this.player.markGenerationComplete();

          const durationSec = buildAudioDurationSec(resultState.samples.length, this.sampleRate);
          resolve({
            audio: {
              samples: Float32Array.from(resultState.samples),
              sampleRate: this.sampleRate,
              durationSec,
            },
            timeline: {
              chunks: resultState.timeline,
              durationSec,
            },
            modelId: this.modelId,
            text: fullText,
          });
        } catch (error) {
          if (this.activeRun?.token === runToken) {
            this.activeRun = null;
          }
          reject(error);
        }
      });

      return await promise;
    } finally {
      this.player.unlock();
    }
  }

  async play(): Promise<void> {
    await this.player.play();
  }

  async pause(): Promise<void> {
    await this.player.pause();
  }

  async stop(): Promise<void> {
    await this.interruptActiveRun("TTS request stopped.");
    this.player.setOnFinishedPlayingCallback(null);
    this.player.clear();
    await this.player.pause();
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.player.dispose();
  }

  private async interruptActiveRun(reason: string): Promise<void> {
    if (!this.activeRun) {
      return;
    }

    const activeRun = this.activeRun;
    this.activeRun = null;
    activeRun.reject(new Error(reason));

    await TtsWorkerBridge.terminateEarly();
  }

  private normalizeSynthesizeOptions(options: TtsSynthesizeOptions): NormalizedSynthesizeOptions {
    if (!options.text) {
      throw new Error("text is required.");
    }

    return {
      text: options.text,
      voice: options.voice,
      sid: normalizeVoiceId(options.voice),
      emotion: normalizeEmotion(options.emotion),
      intensity: normalizeIntensity(options.intensity),
      speed: normalizeSpeed(options.speed),
      silencePaddingSec: normalizeNonNegative(
        options.silencePaddingSec,
        DEFAULT_SILENCE_PADDING_SEC,
      ),
      autoPlay: options.autoPlay ?? true,
      onProgress: options.onProgress,
      onFinishedPlaying: options.onFinishedPlaying,
    };
  }

  private normalizeDialogueOptions(options: TtsDialogueOptions): NormalizedDialogueOptions {
    if (!options.segments?.length) {
      throw new Error("segments is required.");
    }

    const defaultSpeed = normalizeSpeed(options.speed);

    return {
      segments: options.segments.map((segment, index) => {
        if (!segment.text) {
          throw new Error(`segments[${index}].text is required.`);
        }

        return {
          text: segment.text,
          voice: segment.voice,
          sid: normalizeVoiceId(segment.voice),
          emotion: normalizeEmotion(segment.emotion),
          intensity: normalizeIntensity(segment.intensity),
          speed: normalizeSpeed(segment.speed, defaultSpeed),
          sentenceSilencePaddingSec: normalizeNonNegative(
            segment.sentenceSilencePaddingSec,
            DEFAULT_SILENCE_PADDING_SEC,
          ),
        };
      }),
      silenceBetweenSegmentsSec: normalizeNonNegative(
        options.silenceBetweenSegmentsSec,
        DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC,
      ),
      autoPlay: options.autoPlay ?? true,
      onProgress: options.onProgress,
      onFinishedPlaying: options.onFinishedPlaying,
    };
  }
}

export async function loadTtsModel(
  modelId: string,
  options: LoadTtsModelOptions = {},
): Promise<TtsModel> {
  return TtsModel.load(modelId, options);
}

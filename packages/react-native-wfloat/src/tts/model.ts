import type { EventSubscription } from 'react-native';
import Wfloat, {
  type NativeGenerateResult,
  type NativeLoadModelProgressEvent,
  type NativeSpeechPlaybackFinishedEvent,
  type NativeSpeechProgressEvent,
  type NativeTimelineChunk,
} from '../NativeWfloat';
import { getModelAssets } from '../modelAssets';
import { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from './catalog';
import type {
  AudioResult,
  LoadModelProgressEvent,
  LoadTtsModelOptions,
  TimelineChunk,
  TtsDialogueOptions,
  TtsDialogueSegment,
  TtsEmotion,
  TtsProgressEvent,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from './types';

const DEFAULT_EMOTION: TtsEmotion = 'neutral';
const DEFAULT_INTENSITY = 0.5;
const DEFAULT_SPEED = 1;
const DEFAULT_SILENCE_PADDING_SEC = 0.1;
const DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC = 0.2;

let nextRequestId = 1;

type ActiveRun = {
  token: number;
  requestId: number;
  settled: boolean;
  reject: (reason?: unknown) => void;
  onProgress?: (event: TtsProgressEvent) => void;
  onFinishedPlaying?: () => void;
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

function normalizeEmotion(value: unknown): TtsEmotion {
  return VALID_EMOTIONS.includes(value as TtsEmotion) ? (value as TtsEmotion) : DEFAULT_EMOTION;
}

function normalizeIntensity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INTENSITY;
  }

  return Math.min(Math.max(value, 0), 1);
}

function normalizeSpeed(value: unknown, defaultValue = DEFAULT_SPEED): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }

  return value;
}

function normalizeNonNegative(value: unknown, defaultValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(value, 0);
}

function normalizeVoiceId(voice: string | number | undefined): number {
  if (typeof voice === 'number') {
    if (!Number.isInteger(voice) || !VALID_SIDS.includes(voice)) {
      throw new Error(`Invalid numeric voice: ${voice}`);
    }

    return voice;
  }

  if (typeof voice === 'string') {
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

function normalizeLoadProgressEvent(
  event: NativeLoadModelProgressEvent
): LoadModelProgressEvent | null {
  if (event.status === 'downloading') {
    return {
      status: 'downloading',
      progress:
        typeof event.progress === 'number' && Number.isFinite(event.progress)
          ? Math.min(Math.max(event.progress, 0), 1)
          : 0,
    };
  }

  if (event.status === 'loading') {
    return { status: 'loading' };
  }

  if (event.status === 'completed') {
    return { status: 'completed' };
  }

  console.warn(`Ignoring unknown loadModel progress event status "${event.status}".`);
  return null;
}

function mapNativeProgressEvent(event: NativeSpeechProgressEvent): TtsProgressEvent {
  const mapped: TtsProgressEvent = {
    progress:
      typeof event.progress === 'number' && Number.isFinite(event.progress)
        ? Math.min(Math.max(event.progress, 0), 1)
        : 0,
    isPlaying: Boolean(event.isPlaying),
    textHighlightStart:
      typeof event.textHighlightStart === 'number' &&
      Number.isFinite(event.textHighlightStart)
        ? Math.max(0, Math.trunc(event.textHighlightStart))
        : 0,
    textHighlightEnd:
      typeof event.textHighlightEnd === 'number' &&
      Number.isFinite(event.textHighlightEnd)
        ? Math.max(0, Math.trunc(event.textHighlightEnd))
        : 0,
    text: typeof event.text === 'string' ? event.text : '',
  };

  if (
    typeof event.textHighlightSegment === 'number' &&
    Number.isFinite(event.textHighlightSegment)
  ) {
    mapped.textHighlightSegment = Math.max(0, Math.trunc(event.textHighlightSegment));
  }

  return mapped;
}

function mapAudioResult(nativeResult: NativeGenerateResult): AudioResult {
  return {
    sampleRate:
      typeof nativeResult.sampleRate === 'number' && Number.isFinite(nativeResult.sampleRate)
        ? Math.max(0, Math.trunc(nativeResult.sampleRate))
        : 0,
    durationSec:
      typeof nativeResult.durationSec === 'number' && Number.isFinite(nativeResult.durationSec)
        ? Math.max(0, nativeResult.durationSec)
        : 0,
  };
}

export class TtsModel {
  private static nextRunToken = 1;

  private activeRun: ActiveRun | null = null;
  private speechProgressSubscription: EventSubscription | null = null;
  private speechPlaybackFinishedSubscription: EventSubscription | null = null;

  private constructor(public readonly modelId: string) {
    this.subscribeToSpeechEvents();
  }

  static async load(
    modelId: string,
    options: LoadTtsModelOptions = {}
  ): Promise<TtsModel> {
    const loadModelProgressSubscription = Wfloat.onLoadModelProgress(
      (event: NativeLoadModelProgressEvent) => {
        const normalized = normalizeLoadProgressEvent(event);
        if (normalized) {
          options.onProgress?.(normalized);
        }
      }
    );

    try {
      const assets = await getModelAssets(modelId, options.modelAssetHost);
      await Wfloat.loadModel({
        modelId,
        modelUrl: assets.model_onnx,
        tokensUrl: assets.model_tokens,
        espeakDataUrl: assets.espeak_data,
        espeakChecksum: assets.espeak_checksum,
      });
    } finally {
      loadModelProgressSubscription.remove();
    }

    options.onProgress?.({ status: 'completed' });
    return new TtsModel(modelId);
  }

  async synthesize(options: TtsSynthesizeOptions): Promise<TtsSynthesisResult> {
    const normalized = this.normalizeSynthesizeOptions(options);
    await this.interruptActiveRun('TTS request interrupted by a new request.');

    const requestId = nextRequestId;
    nextRequestId += 1;
    const runToken = TtsModel.nextRunToken;
    TtsModel.nextRunToken += 1;

    return new Promise<TtsSynthesisResult>(async (resolve, reject) => {
      this.activeRun = {
        token: runToken,
        requestId,
        settled: false,
        reject,
        onProgress: normalized.onProgress,
        onFinishedPlaying: normalized.onFinishedPlaying,
      };

      try {
        const nativeResult = await Wfloat.generate({
          requestId,
          text: normalized.text,
          sid: normalized.sid,
          emotion: normalized.emotion,
          intensity: normalized.intensity,
          speed: normalized.speed,
          silencePaddingSec: normalized.silencePaddingSec,
          autoPlay: normalized.autoPlay,
        });

        if (this.activeRun?.token !== runToken) {
          return;
        }

        this.activeRun.settled = true;
        resolve({
          audio: mapAudioResult(nativeResult),
          timeline: {
            chunks: nativeResult.timelineChunks.map((chunk: NativeTimelineChunk): TimelineChunk => ({
              index: Math.max(0, Math.trunc(chunk.index)),
              text: chunk.text,
              highlightStart: Math.max(0, Math.trunc(chunk.textHighlightStart)),
              highlightEnd: Math.max(0, Math.trunc(chunk.textHighlightEnd)),
              startSec: Math.max(0, chunk.startSec),
              endSec: Math.max(0, chunk.endSec),
              durationSec: Math.max(0, chunk.durationSec),
              progress: Math.min(Math.max(chunk.progress, 0), 1),
              voice: normalized.voice,
            })),
            durationSec: Math.max(0, nativeResult.durationSec),
          },
          modelId: this.modelId,
          text: nativeResult.text,
        });
      } catch (error) {
        if (this.activeRun?.token === runToken) {
          this.activeRun = null;
        }

        reject(error);
      }
    });
  }

  async synthesizeDialogue(options: TtsDialogueOptions): Promise<TtsSynthesisResult> {
    const normalized = this.normalizeDialogueOptions(options);
    await this.interruptActiveRun('TTS request interrupted by a new request.');

    const requestId = nextRequestId;
    nextRequestId += 1;
    const runToken = TtsModel.nextRunToken;
    TtsModel.nextRunToken += 1;

    return new Promise<TtsSynthesisResult>(async (resolve, reject) => {
      this.activeRun = {
        token: runToken,
        requestId,
        settled: false,
        reject,
        onProgress: normalized.onProgress,
        onFinishedPlaying: normalized.onFinishedPlaying,
      };

      try {
        const nativeResult = await Wfloat.generateDialogue({
          requestId,
          segments: normalized.segments.map((segment) => ({
            text: segment.text,
            sid: segment.sid,
            emotion: segment.emotion,
            intensity: segment.intensity,
            speed: segment.speed,
            sentenceSilencePaddingSec: segment.sentenceSilencePaddingSec,
          })),
          silenceBetweenSegmentsSec: normalized.silenceBetweenSegmentsSec,
          autoPlay: normalized.autoPlay,
        });

        if (this.activeRun?.token !== runToken) {
          return;
        }

        this.activeRun.settled = true;
        resolve({
          audio: mapAudioResult(nativeResult),
          timeline: {
            chunks: nativeResult.timelineChunks.map((chunk: NativeTimelineChunk): TimelineChunk => {
              const segmentIndex =
                typeof chunk.textHighlightSegment === 'number' &&
                Number.isFinite(chunk.textHighlightSegment)
                  ? Math.max(0, Math.trunc(chunk.textHighlightSegment))
                  : undefined;

              return {
                index: Math.max(0, Math.trunc(chunk.index)),
                text: chunk.text,
                highlightStart: Math.max(0, Math.trunc(chunk.textHighlightStart)),
                highlightEnd: Math.max(0, Math.trunc(chunk.textHighlightEnd)),
                startSec: Math.max(0, chunk.startSec),
                endSec: Math.max(0, chunk.endSec),
                durationSec: Math.max(0, chunk.durationSec),
                progress: Math.min(Math.max(chunk.progress, 0), 1),
                voice:
                  segmentIndex === undefined
                    ? undefined
                    : normalized.segments[segmentIndex]?.voice,
                segmentIndex,
              };
            }),
            durationSec: Math.max(0, nativeResult.durationSec),
          },
          modelId: this.modelId,
          text: nativeResult.text,
        });
      } catch (error) {
        if (this.activeRun?.token === runToken) {
          this.activeRun = null;
        }

        reject(error);
      }
    });
  }

  async play(): Promise<void> {
    await Wfloat.play();
  }

  async pause(): Promise<void> {
    await Wfloat.pause();
  }

  dispose(): void {
    if (this.activeRun && !this.activeRun.settled) {
      this.activeRun.reject(new Error('TTS model disposed before the request completed.'));
    }

    this.activeRun = null;
    this.speechProgressSubscription?.remove();
    this.speechProgressSubscription = null;
    this.speechPlaybackFinishedSubscription?.remove();
    this.speechPlaybackFinishedSubscription = null;
  }

  private subscribeToSpeechEvents(): void {
    if (!this.speechProgressSubscription) {
      this.speechProgressSubscription = Wfloat.onSpeechProgress(
        (event: NativeSpeechProgressEvent) => {
          const activeRun = this.activeRun;
          if (!activeRun || activeRun.requestId !== event.requestId) {
            return;
          }

          activeRun.onProgress?.(mapNativeProgressEvent(event));
        }
      );
    }

    if (!this.speechPlaybackFinishedSubscription) {
      this.speechPlaybackFinishedSubscription = Wfloat.onSpeechPlaybackFinished(
        (event: NativeSpeechPlaybackFinishedEvent) => {
          const activeRun = this.activeRun;
          if (!activeRun || activeRun.requestId !== event.requestId) {
            return;
          }

          const onFinishedPlaying = activeRun.onFinishedPlaying;
          this.activeRun = null;
          onFinishedPlaying?.();
        }
      );
    }
  }

  private async interruptActiveRun(reason: string): Promise<void> {
    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }

    if (!activeRun.settled) {
      activeRun.reject(new Error(reason));
    }

    this.activeRun = null;
  }

  private normalizeSynthesizeOptions(
    options: TtsSynthesizeOptions
  ): NormalizedSynthesizeOptions {
    if (!options.text) {
      throw new Error('text is required.');
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
        DEFAULT_SILENCE_PADDING_SEC
      ),
      autoPlay: options.autoPlay ?? true,
      onProgress: options.onProgress,
      onFinishedPlaying: options.onFinishedPlaying,
    };
  }

  private normalizeDialogueOptions(
    options: TtsDialogueOptions
  ): NormalizedDialogueOptions {
    if (!options.segments?.length) {
      throw new Error('segments is required.');
    }

    const defaultSpeed = normalizeSpeed(options.speed);

    return {
      segments: options.segments.map((segment, index) =>
        this.normalizeDialogueSegment(segment, index, defaultSpeed)
      ),
      silenceBetweenSegmentsSec: normalizeNonNegative(
        options.silenceBetweenSegmentsSec,
        DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC
      ),
      autoPlay: options.autoPlay ?? true,
      onProgress: options.onProgress,
      onFinishedPlaying: options.onFinishedPlaying,
    };
  }

  private normalizeDialogueSegment(
    segment: TtsDialogueSegment,
    index: number,
    defaultSpeed: number
  ): NormalizedDialogueSegment {
    if (!segment.text) {
      throw new Error(`segments[${index}].text is required.`);
    }

    return {
      text: segment.text,
      voice: segment.voice,
      sid: normalizeVoiceId(segment.voice),
      emotion: normalizeEmotion(segment.emotion),
      intensity: normalizeIntensity(segment.intensity),
      speed:
        typeof segment.speed === 'number' && Number.isFinite(segment.speed)
          ? normalizeSpeed(segment.speed)
          : defaultSpeed,
      sentenceSilencePaddingSec: normalizeNonNegative(
        segment.sentenceSilencePaddingSec,
        DEFAULT_SILENCE_PADDING_SEC
      ),
    };
  }
}

export async function loadTtsModel(
  modelId: string,
  options: LoadTtsModelOptions = {}
): Promise<TtsModel> {
  return TtsModel.load(modelId, options);
}

import Wfloat, {
  type NativeLoadModelProgressEvent,
  type NativeVadDetectionResult,
  type NativeVadSegment,
} from '../NativeWfloat';
import { getVadModelAssets } from '../modelAssets';
import type {
  LoadVadModelOptions,
  VadDetectOptions,
  VadDetectionResult,
  VadSegment,
} from './types';

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_SILENCE_DURATION_SEC = 0.5;
const DEFAULT_MIN_SPEECH_DURATION_SEC = 0.25;
const DEFAULT_MAX_SPEECH_DURATION_SEC = 20;

function normalizeLoadProgressEvent(
  event: NativeLoadModelProgressEvent
): import('../tts/types').LoadModelProgressEvent | null {
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

function normalizeAudioSamples(audio: ReadonlyArray<number> | Float32Array): number[] {
  if (audio instanceof Float32Array) {
    return Array.from(audio);
  }

  return Array.from(audio, (value) => Number(value));
}

function finiteNumberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapVadSegment(segment: NativeVadSegment): VadSegment {
  const sampleRate =
    typeof segment.sampleRate === 'number' && Number.isFinite(segment.sampleRate)
      ? Math.max(1, Math.trunc(segment.sampleRate))
      : 16000;

  return {
    startSec:
      typeof segment.startSec === 'number' && Number.isFinite(segment.startSec)
        ? segment.startSec
        : 0,
    durationSec:
      typeof segment.durationSec === 'number' && Number.isFinite(segment.durationSec)
        ? segment.durationSec
        : 0,
    endSec:
      typeof segment.endSec === 'number' && Number.isFinite(segment.endSec)
        ? segment.endSec
        : 0,
    startSample:
      typeof segment.startSample === 'number' && Number.isFinite(segment.startSample)
        ? Math.max(0, Math.trunc(segment.startSample))
        : 0,
    sampleCount:
      typeof segment.sampleCount === 'number' && Number.isFinite(segment.sampleCount)
        ? Math.max(0, Math.trunc(segment.sampleCount))
        : 0,
    sampleRate,
    audio: Float32Array.from(Array.isArray(segment.audio) ? segment.audio : []),
  };
}

function mapVadResult(result: NativeVadDetectionResult): VadDetectionResult {
  return {
    modelId: typeof result.modelId === 'string' ? result.modelId : '',
    segments: Array.isArray(result.segments)
      ? result.segments.map(mapVadSegment)
      : [],
    speechRatio:
      typeof result.speechRatio === 'number' && Number.isFinite(result.speechRatio)
        ? Math.min(Math.max(result.speechRatio, 0), 1)
        : 0,
  };
}

export class VadModel {
  private constructor(
    public readonly modelId: string,
    public readonly family: string
  ) {}

  static async load(
    modelId: string,
    options: LoadVadModelOptions = {}
  ): Promise<VadModel> {
    const modelAssets = await getVadModelAssets(modelId, options.modelAssetHost);
    const progressSubscription = Wfloat.onLoadModelProgress(
      (event: NativeLoadModelProgressEvent) => {
        const normalized = normalizeLoadProgressEvent(event);
        if (normalized) {
          options.onProgress?.(normalized);
        }
      }
    );

    try {
      const nativeResult = await Wfloat.loadVadModel({
        modelId,
        family: modelAssets.family,
        modelUrl: modelAssets.model,
        threshold: finiteNumberOrDefault(options.threshold, DEFAULT_THRESHOLD),
        minSilenceDurationSec: finiteNumberOrDefault(
          options.minSilenceDurationSec,
          DEFAULT_MIN_SILENCE_DURATION_SEC
        ),
        minSpeechDurationSec: finiteNumberOrDefault(
          options.minSpeechDurationSec,
          DEFAULT_MIN_SPEECH_DURATION_SEC
        ),
        maxSpeechDurationSec: finiteNumberOrDefault(
          options.maxSpeechDurationSec,
          DEFAULT_MAX_SPEECH_DURATION_SEC
        ),
      });
      options.onProgress?.({ status: 'completed' });
      return new VadModel(modelId, nativeResult.family);
    } finally {
      progressSubscription.remove();
    }
  }

  async detect(options: VadDetectOptions): Promise<VadDetectionResult> {
    return mapVadResult(
      await Wfloat.detectVad({
        samples: normalizeAudioSamples(options.audio),
        sampleRate: Math.max(1, Math.trunc(options.sampleRate)),
      })
    );
  }
}

export async function loadVadModel(
  modelId: string,
  options: LoadVadModelOptions = {}
): Promise<VadModel> {
  return VadModel.load(modelId, options);
}

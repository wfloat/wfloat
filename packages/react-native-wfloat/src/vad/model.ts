import Wfloat, {
  type NativeLoadModelProgressEvent,
  type NativeVadDetectionResult,
  type NativeVadSpeechStartEvent,
  type NativeVadSegment,
} from '../NativeWfloat';
import { PermissionsAndroid, Platform } from 'react-native';
import { getVadModelAssets } from '../modelAssets';
import type {
  LoadVadModelOptions,
  VadDetectOptions,
  VadDetectionResult,
  VadMicrophoneCaptureResult,
  VadMicrophoneOptions,
  VadSegment,
  VadSessionOptions,
  VadSpeechStartEvent,
} from './types';

const TARGET_SAMPLE_RATE = 16000;
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

function mapVadSpeechStartEvent(
  event: NativeVadSpeechStartEvent
): VadSpeechStartEvent {
  return {
    modelId: typeof event.modelId === 'string' ? event.modelId : '',
    sampleRate:
      typeof event.sampleRate === 'number' && Number.isFinite(event.sampleRate)
        ? Math.max(1, Math.trunc(event.sampleRate))
        : TARGET_SAMPLE_RATE,
    startSample:
      typeof event.startSample === 'number' && Number.isFinite(event.startSample)
        ? Math.max(0, Math.trunc(event.startSample))
        : 0,
    startSec:
      typeof event.startSec === 'number' && Number.isFinite(event.startSec)
        ? event.startSec
        : 0,
  };
}

async function ensureMicrophonePermission(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (!permission) {
    throw new Error('Android RECORD_AUDIO permission is not available in this React Native runtime.');
  }

  const hasPermission = await PermissionsAndroid.check(permission);
  if (hasPermission) {
    return;
  }

  const result = await PermissionsAndroid.request(permission);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Microphone permission is required for VAD microphone capture.');
  }
}

export class VadSession {
  private startSubscription: { remove(): void } | null = null;
  private endSubscription: { remove(): void } | null = null;
  private microphoneActive = false;

  constructor(
    public readonly modelId: string,
    private readonly options: VadSessionOptions
  ) {}

  async startMicrophone(
    options: VadMicrophoneOptions = {}
  ): Promise<void> {
    this.removeSubscriptions();
    await ensureMicrophonePermission();

    const sampleRate =
      typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
        ? Math.max(1, Math.trunc(options.sampleRate))
        : TARGET_SAMPLE_RATE;

    this.startSubscription = Wfloat.onVadSpeechStart((event) => {
      if (event.modelId === this.modelId) {
        this.options.onSpeechStart?.(mapVadSpeechStartEvent(event));
      }
    });
    this.endSubscription = Wfloat.onVadSpeechEnd((event) => {
      if (event.modelId === this.modelId) {
        this.options.onSpeechEnd?.(mapVadSegment(event.segment));
      }
    });

    try {
      await Wfloat.startVadSessionMicrophone({ sampleRate });
      this.microphoneActive = true;
    } catch (error) {
      this.removeSubscriptions();
      throw error;
    }
  }

  async stopMicrophone(): Promise<VadMicrophoneCaptureResult> {
    this.microphoneActive = false;
    try {
      return await Wfloat.stopVadSessionMicrophone();
    } finally {
      this.removeSubscriptions();
    }
  }

  async close(): Promise<void> {
    if (this.microphoneActive) {
      await this.stopMicrophone().catch(() => {});
      return;
    }

    this.removeSubscriptions();
  }

  private removeSubscriptions(): void {
    this.startSubscription?.remove();
    this.endSubscription?.remove();
    this.startSubscription = null;
    this.endSubscription = null;
  }
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
    const modelAssets = await getVadModelAssets(modelId);
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

  async createSession(options: VadSessionOptions = {}): Promise<VadSession> {
    return new VadSession(this.modelId, options);
  }
}

export async function loadVadModel(
  modelId: string,
  options: LoadVadModelOptions = {}
): Promise<VadModel> {
  return VadModel.load(modelId, options);
}

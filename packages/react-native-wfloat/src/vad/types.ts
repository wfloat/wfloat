import type { LoadModelProgressEvent } from '../tts/types';

export type LoadVadModelOptions = {
  onProgress?: (event: LoadModelProgressEvent) => void;
  modelAssetHost?: string;
  threshold?: number;
  minSilenceDurationSec?: number;
  minSpeechDurationSec?: number;
  maxSpeechDurationSec?: number;
};

export type VadDetectOptions = {
  audio: ReadonlyArray<number> | Float32Array;
  sampleRate: number;
};

export type VadSpeechStartEvent = {
  modelId: string;
  sampleRate: number;
  startSample: number;
  startSec: number;
};

export type VadSessionOptions = {
  onSpeechStart?: (event: VadSpeechStartEvent) => void | Promise<void>;
  onSpeechEnd?: (segment: VadSegment) => void | Promise<void>;
};

export type VadMicrophoneOptions = {
  sampleRate?: number;
};

export type VadMicrophoneCaptureResult = {
  durationMs: number;
  sampleRate: number;
  callbackCount: number;
  emittedWindowCount: number;
  speechStartCount: number;
  speechEndCount: number;
  inputChannels: number;
  inputSampleRate: number;
  lastInputFrameLength: number;
  lastRawRms: number;
  lastNormalizedRms: number;
  maxRawRms: number;
  maxNormalizedRms: number;
};

export type VadSegment = {
  startSec: number;
  durationSec: number;
  endSec: number;
  startSample: number;
  sampleCount: number;
  sampleRate: number;
  audio: Float32Array;
};

export type VadDetectionResult = {
  modelId: string;
  segments: VadSegment[];
  speechRatio: number;
};

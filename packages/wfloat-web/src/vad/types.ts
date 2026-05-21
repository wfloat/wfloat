import type { LoadModelProgressEvent } from "../tts/types.js";

export type LoadVadModelOptions = {
  onProgress?: (event: LoadModelProgressEvent) => void;
  modelAssetHost?: string;
  threshold?: number;
  minSilenceDurationSec?: number;
  minSpeechDurationSec?: number;
  maxSpeechDurationSec?: number;
};

export type VadDetectOptions = {
  audio: Blob | ArrayBuffer | Float32Array | AudioBuffer;
  sampleRate?: number;
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
  chunkCount: number;
  emittedWindowCount: number;
  speechStartCount: number;
  speechEndCount: number;
  maxRms: number;
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

export type DecodedVadAudio = {
  samples: Float32Array;
  sampleRate: number;
};

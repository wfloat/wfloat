import type { LoadModelProgressEvent } from "../tts/types.js";

export type TranscriptionToken = {
  text: string;
  startSec: number;
  durationSec: number;
  confidence: number;
};

export type TranscriptionSegment = {
  text: string;
  startSec: number;
  durationSec: number;
};

export type TranscriptionResult = {
  text: string;
  modelId: string;
  language: string;
  emotion: string;
  event: string;
  json: string;
  tokens?: TranscriptionToken[];
  segments?: TranscriptionSegment[];
};

export type StreamingTranscriptionResult = {
  text: string;
  modelId: string;
  isEndpoint: boolean;
  json: string;
};

export type LoadSttModelOptions = {
  onProgress?: (event: LoadModelProgressEvent) => void;
  modelAssetHost?: string;
  language?: string;
  task?: "transcribe" | "translate";
};

export type TranscribeOptions = {
  audio: Blob | ArrayBuffer | Float32Array | AudioBuffer;
  sampleRate?: number;
};

export type DecodedAudio = {
  samples: Float32Array;
  sampleRate: number;
};

export type StreamingTranscribeChunk = {
  audio: Float32Array;
  sampleRate?: number;
};

export type SttMicrophoneRecordingOptions = {
  sampleRate?: number;
};

export type SttMicrophoneRecording = TranscribeOptions & {
  durationMs: number;
};

export type SttMicrophoneOptions = {
  sampleRate?: number;
  onResult?: (result: StreamingTranscriptionResult) => void | Promise<void>;
};

export type SttMicrophoneCaptureResult = {
  durationMs: number;
  sampleRate: number;
  chunkCount: number;
};

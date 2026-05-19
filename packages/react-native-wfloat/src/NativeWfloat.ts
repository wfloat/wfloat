import type { TurboModule } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';
import { TurboModuleRegistry } from 'react-native';

export type LoadModelNativeOptions = {
  modelId: string;
  modelUrl: string;
  tokensUrl: string;
  espeakDataUrl: string;
  espeakChecksum: string;
};

export type LoadSttModelNativeOptions = {
  modelId: string;
  family: string;
  modelUrl: string;
  tokensUrl: string;
  preprocessorUrl: string;
  encoderUrl: string;
  decoderUrl: string;
  joinerUrl: string;
  uncachedDecoderUrl: string;
  cachedDecoderUrl: string;
  language: string;
  task: string;
};

export type LoadVadModelNativeOptions = {
  modelId: string;
  family: string;
  modelUrl: string;
  threshold: number;
  minSilenceDurationSec: number;
  minSpeechDurationSec: number;
  maxSpeechDurationSec: number;
};

export type GenerateNativeOptions = {
  requestId: number;
  text: string;
  sid: number;
  emotion: string;
  intensity: number;
  speed: number;
  silencePaddingSec: number;
  autoPlay: boolean;
};

export type GenerateDialogueNativeSegment = {
  text: string;
  sid: number;
  emotion: string;
  intensity: number;
  speed: number;
  sentenceSilencePaddingSec: number;
};

export type GenerateDialogueNativeOptions = {
  requestId: number;
  segments: GenerateDialogueNativeSegment[];
  silenceBetweenSegmentsSec: number;
  autoPlay: boolean;
};

export type NativeTimelineChunk = {
  index: number;
  text: string;
  textHighlightStart: number;
  textHighlightEnd: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  progress: number;
  textHighlightSegment?: number;
};

export type NativeGenerateResult = {
  sampleRate: number;
  durationSec: number;
  text: string;
  timelineChunks: NativeTimelineChunk[];
};

export type TranscribeNativeOptions = {
  samples: number[];
  sampleRate: number;
  language: string;
  task: string;
  hotwords: string;
};

export type VadDetectNativeOptions = {
  samples: number[];
  sampleRate: number;
};

export type SttSessionNativeOptions = {
  sessionId: number;
};

export type SttMicrophoneRecordingNativeOptions = {
  sampleRate: number;
};

export type SttSessionMicrophoneNativeOptions = {
  sessionId: number;
  sampleRate: number;
  chunkMs: number;
};

export type PushSttSessionAudioNativeOptions = {
  sessionId: number;
  samples: number[];
  sampleRate: number;
};

export type NativeTranscriptionToken = {
  text: string;
  startSec: number;
  durationSec: number;
  confidence: number;
};

export type NativeTranscriptionSegment = {
  text: string;
  startSec: number;
  durationSec: number;
};

export type NativeTranscriptionResult = {
  text: string;
  modelId: string;
  language: string;
  emotion: string;
  event: string;
  json: string;
  tokens: NativeTranscriptionToken[];
  segments: NativeTranscriptionSegment[];
};

export type NativeStreamingTranscriptionResult = {
  text: string;
  modelId: string;
  isEndpoint: boolean;
  json: string;
};

export type NativeLoadSttModelResult = {
  family: string;
  supportsStreaming: boolean;
};

export type NativeLoadVadModelResult = {
  family: string;
};

export type NativeVadSegment = {
  startSec: number;
  durationSec: number;
  endSec: number;
  startSample: number;
  sampleCount: number;
  sampleRate: number;
  audio: number[];
};

export type NativeVadDetectionResult = {
  modelId: string;
  segments: NativeVadSegment[];
  speechRatio: number;
};

export type NativeSttMicrophoneCaptureResult = {
  durationMs: number;
  sampleRate: number;
  callbackCount: number;
  emittedChunkCount: number;
  inputChannels: number;
  inputSampleRate: number;
  lastInputFrameLength: number;
  lastRawRms: number;
  lastNormalizedRms: number;
  maxRawRms: number;
  maxNormalizedRms: number;
};

export type NativeSttMicrophoneRecordingResult = {
  durationMs: number;
  sampleRate: number;
  samples: number[];
};

export type NativeLoadModelProgressEvent = {
  status: string;
  progress?: number;
};

export type NativeSpeechProgressEvent = {
  requestId: number;
  progress: number;
  isPlaying: boolean;
  textHighlightStart: number;
  textHighlightEnd: number;
  text: string;
  textHighlightSegment?: number;
};

export type NativeSpeechPlaybackFinishedEvent = {
  requestId: number;
};

export interface Spec extends TurboModule {
  loadModel(options: LoadModelNativeOptions): Promise<void>;
  loadSttModel(options: LoadSttModelNativeOptions): Promise<NativeLoadSttModelResult>;
  loadVadModel(options: LoadVadModelNativeOptions): Promise<NativeLoadVadModelResult>;
  generate(options: GenerateNativeOptions): Promise<NativeGenerateResult>;
  generateDialogue(
    options: GenerateDialogueNativeOptions
  ): Promise<NativeGenerateResult>;
  transcribe(options: TranscribeNativeOptions): Promise<NativeTranscriptionResult>;
  detectVad(options: VadDetectNativeOptions): Promise<NativeVadDetectionResult>;
  startSttMicrophoneRecording(
    options: SttMicrophoneRecordingNativeOptions
  ): Promise<void>;
  stopSttMicrophoneRecording(): Promise<NativeSttMicrophoneRecordingResult>;
  createSttSession(): Promise<number>;
  pushSttSessionAudio(options: PushSttSessionAudioNativeOptions): Promise<void>;
  startSttSessionMicrophone(
    options: SttSessionMicrophoneNativeOptions
  ): Promise<void>;
  stopSttSessionMicrophone(
    options: SttSessionNativeOptions
  ): Promise<NativeSttMicrophoneCaptureResult>;
  getSttSessionResult(
    options: SttSessionNativeOptions
  ): Promise<NativeStreamingTranscriptionResult>;
  finishSttSession(
    options: SttSessionNativeOptions
  ): Promise<NativeStreamingTranscriptionResult>;
  resetSttSession(options: SttSessionNativeOptions): Promise<void>;
  closeSttSession(options: SttSessionNativeOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  readonly onLoadModelProgress: EventEmitter<NativeLoadModelProgressEvent>;
  readonly onSpeechProgress: EventEmitter<NativeSpeechProgressEvent>;
  readonly onSpeechPlaybackFinished: EventEmitter<NativeSpeechPlaybackFinishedEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Wfloat');

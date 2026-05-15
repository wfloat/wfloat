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

export type SttSessionNativeOptions = {
  sessionId: number;
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
  generate(options: GenerateNativeOptions): Promise<NativeGenerateResult>;
  generateDialogue(
    options: GenerateDialogueNativeOptions
  ): Promise<NativeGenerateResult>;
  transcribe(options: TranscribeNativeOptions): Promise<NativeTranscriptionResult>;
  createSttSession(): Promise<number>;
  pushSttSessionAudio(options: PushSttSessionAudioNativeOptions): Promise<void>;
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

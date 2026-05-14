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
  generate(options: GenerateNativeOptions): Promise<NativeGenerateResult>;
  generateDialogue(
    options: GenerateDialogueNativeOptions
  ): Promise<NativeGenerateResult>;
  play(): Promise<void>;
  pause(): Promise<void>;
  readonly onLoadModelProgress: EventEmitter<NativeLoadModelProgressEvent>;
  readonly onSpeechProgress: EventEmitter<NativeSpeechProgressEvent>;
  readonly onSpeechPlaybackFinished: EventEmitter<NativeSpeechPlaybackFinishedEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Wfloat');

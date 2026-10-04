import type { DownloadModelOptions } from '../assets/types.js';
import type { PcmAudio, TranscriptionAudio } from '../stt-next/types.js';
import type { MicrophoneCapture } from '../audio-next/microphone.js';
export type LoadVoiceActivityDetectionOptions = DownloadModelOptions;
export type VadAudioInput = TranscriptionAudio;
export type VadSpeechRange = { readonly id: string; readonly startMs: number; readonly endMs: number };
export type VadSpeechStartEvent = { readonly id: string; readonly startMs: number };
export type VadProbabilityEvent = { readonly probability: number; readonly startMs: number; readonly endMs: number };
export type VadSpeechSegment<R extends boolean = false> = VadSpeechRange & (R extends true ? { readonly audio: PcmAudio } : {});
export type DetectionData<R extends boolean = false> = { readonly segments: readonly VadSpeechSegment<R>[] };
export type DetectionResult<R extends boolean = false> = DetectionData<R> & { readonly stopReason: 'complete' | 'cancelled' };
export type VadSessionData = { readonly segments: readonly VadSpeechRange[] };
export type VadSessionResult = VadSessionData & { readonly stopReason: 'complete' | 'cancelled' };
export class VadError<TPartial = VadSessionData> extends Error {
  readonly name = 'VadError';
  constructor(message: string, readonly partialResult: TPartial, readonly cause?: unknown) { super(message); }
}
export type VadOptions<R extends boolean = false> = {
  speechThreshold?: number;
  silenceThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
  speechPaddingMs?: number;
  returnAudio?: R;
  onProbability?: (event: VadProbabilityEvent) => void;
};
export type VadSessionOptions<R extends boolean = false> = VadOptions<R> & {
  onSpeechStart?: (event: VadSpeechStartEvent) => void;
  onSpeechEnd?: (event: VadSpeechSegment<R>) => void;
  onError?: (error: VadError<VadSessionData>) => void;
};
export interface Detection<R extends boolean = false> { result(): Promise<DetectionResult<R>>; cancel(): void }
export interface VadSession {
  push(audio: PcmAudio): Promise<void>;
  startMicrophone(): Promise<void>;
  attachMicrophone(source: MicrophoneCapture): Promise<void>;
  finish(): Promise<VadSessionResult>;
  result(): Promise<VadSessionResult>;
  cancel(): void;
}

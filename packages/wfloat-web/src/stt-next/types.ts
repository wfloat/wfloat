import type { DownloadModelOptions } from '../assets/types.js';

export type LoadSpeechToTextOptions = DownloadModelOptions;
export type TranscriptTiming = { readonly startMs: number; readonly endMs: number };
export type TranscriptWord = { readonly text: string; readonly timing?: TranscriptTiming };
export type TranscriptSegment = {
  readonly text: string;
  readonly speakerId?: string;
  readonly timing?: TranscriptTiming;
  readonly words?: readonly TranscriptWord[];
};
export type LiveTranscriptSegment = TranscriptSegment & { readonly id: string };
export type TranscriptData = {
  readonly text: string;
  readonly segments?: readonly TranscriptSegment[];
  readonly words?: readonly TranscriptWord[];
};
export type LiveTranscriptData = Omit<TranscriptData, 'segments'> & { readonly segments: readonly LiveTranscriptSegment[] };
export type ProvisionalTranscript = { readonly text: string };
export type PartialTranscript = TranscriptData & { readonly provisional?: ProvisionalTranscript };
export type LivePartialTranscript = LiveTranscriptData & { readonly provisional?: ProvisionalTranscript };
export type TranscriptionResult =
  | (TranscriptData & { readonly stopReason: 'complete'; readonly provisional?: never })
  | (PartialTranscript & { readonly stopReason: 'cancelled' });
export type LiveTranscriptionResult =
  | (LiveTranscriptData & { readonly stopReason: 'complete'; readonly provisional?: never })
  | (LivePartialTranscript & { readonly stopReason: 'cancelled' });
export type TranscriptionUpdate = { readonly text: string };
export type LiveTranscriptUpdate = LiveTranscriptSegment & { readonly isFinal: boolean };
export class TranscriptionError<TPartial extends PartialTranscript = PartialTranscript> extends Error {
  readonly name = 'TranscriptionError';
  constructor(message: string, readonly partialResult: TPartial, readonly cause?: unknown) { super(message); }
}
export type PcmAudio = { readonly samples: Float32Array; readonly sampleRate: number };
export type TranscriptionAudio = PcmAudio | Blob | AudioBuffer;
export type RecognitionOptions = {
  language?: string;
  task?: 'transcribe' | 'translate';
  timestamps?: 'segment' | 'word';
  hotwords?: readonly string[];
};
export type TranscribeOptions = RecognitionOptions & { onTranscript?: (event: TranscriptionUpdate) => void };
export type TranscriptionSessionOptions = RecognitionOptions & {
  maxBufferedAudioMs?: number;
  onTranscript?: (event: LiveTranscriptUpdate) => void;
  onError?: (error: TranscriptionError<LivePartialTranscript>) => void;
};
export interface Transcription { result(): Promise<TranscriptionResult>; cancel(): void }
export interface TranscriptionSession {
  /** Accept owned audio; this does not wait for recognition or provide backpressure. */
  push(audio: PcmAudio): Promise<void>;
  startMicrophone(): Promise<void>;
  finish(): Promise<LiveTranscriptionResult>;
  result(): Promise<LiveTranscriptionResult>;
  cancel(): void;
}

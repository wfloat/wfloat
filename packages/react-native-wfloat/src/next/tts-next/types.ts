import type { TranscriptionAudio } from '../stt-next/types';
export type SpeechHighlight = { segmentIndex: number; text: string; textStart: number; textEnd: number };
export type SpeechTiming = SpeechHighlight & { startMs: number; endMs: number };
/** Samples are borrowed, read-only: copy before writing or transferring. */
export type SpeechAudio = { samples: Float32Array; sampleRate: number };
export type SpeechChunk = { audio: SpeechAudio; startMs: number; timeline: SpeechTiming[] };
export type SpeechResult = { audio: SpeechAudio; timeline: SpeechTiming[] };
export type PlaybackEvent =
  | { state: 'buffering' | 'playing' | 'paused' | 'finished' | 'cancelled'; highlight: SpeechHighlight | null }
  | { state: 'failed'; highlight: null; error: Error };
export type PlaybackOptions = { backgroundBehavior?: 'continue' | 'pauseAndAutoResume' | 'pauseUntilResumed'; audioFocus?: 'interruptOthers' | 'duckOthers' | 'mixWithOthers'; onPlayback?: (event: PlaybackEvent) => void };
export type SynthesisOptions = { voiceId?: string | number; emotion?: string; intensity?: number; speed?: number; temperature?: number; seed?: number; inferenceSteps?: number; referenceAudio?: TranscriptionAudio };
export type SpeechSegment = SynthesisOptions & { text: string; pauseAfterMs?: number };
export type GenerateOptions = SynthesisOptions & { pauseBetweenSegmentsMs?: number };
export type SpeakOptions = GenerateOptions & PlaybackOptions;
export interface SpeechHandle { pause(): void; resume(): void; cancel(): void }
export interface SpeechGeneration {
  readonly finished: Promise<void>;
  readonly audio: AsyncIterable<SpeechChunk>;
  result(): Promise<SpeechResult>;
  speak(options?: PlaybackOptions): SpeechHandle;
  dispose(): void;
}

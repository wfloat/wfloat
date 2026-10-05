import type { SpeechAudio, SpeechSegment } from './types.js';
/** Adapter-owned synthesis text; offsets always refer to the original segment. */
export type PreparedUnit = { text: string; textStart: number; textEnd: number };
/** Internal injection seam. One backend belongs exclusively to one model instance. */
export interface TextToSpeechBackend {
  readonly sampleRate: number;
  validate(segment: SpeechSegment): void;
  prepare(segment: SpeechSegment): Promise<PreparedUnit[]>;
  synthesize(unit: PreparedUnit, segment: SpeechSegment): Promise<SpeechAudio>;
  unload(): Promise<void>;
}

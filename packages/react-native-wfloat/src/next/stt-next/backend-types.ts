import type { RecognitionOptions, TranscriptData } from './types';
export interface SpeechToTextBackend {
  readonly kind: 'offline' | 'online';
  validate(options: RecognitionOptions): void;
  configure(options: RecognitionOptions): Promise<void>;
  decode(samples: Float32Array): Promise<TranscriptData>;
  openStream(): Promise<void>;
  pushStream(samples: Float32Array, finish?: boolean): Promise<{ text: string; isEndpoint: boolean }>;
  resetStream(): Promise<void>;
  closeStream(): Promise<void>;
  setFailureHandler(handler: (error: Error) => void): void;
  unload(): Promise<void>;
}

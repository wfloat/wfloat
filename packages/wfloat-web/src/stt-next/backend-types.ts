import type { RecognitionOptions, TranscriptData } from './types.js';
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
export type WorkerAssets = {
  wasm: Uint8Array; tokens: Uint8Array; encoder: Uint8Array;
  decoder?: Uint8Array; joiner?: Uint8Array; preprocessor?: Uint8Array;
  uncached_decoder?: Uint8Array; cached_decoder?: Uint8Array; merged_decoder?: Uint8Array;
};
export type WorkerRequest = { id: number } & (
  | { type: 'init'; modelId: string; assets: WorkerAssets }
  | { type: 'configure'; options: RecognitionOptions }
  | { type: 'decode'; samples: Float32Array }
  | { type: 'push'; samples: Float32Array; finish: boolean }
  | { type: 'open' | 'reset' | 'close' | 'unload' }
);
export type WorkerResponse = { id: number; value?: unknown; error?: { name: string; message: string; stack?: string }; fatal?: boolean };

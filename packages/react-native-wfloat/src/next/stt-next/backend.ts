import type { SpeechToTextBackend } from './backend-types';
import type { RecognitionOptions, TranscriptData } from './types';
import { sttCapabilities, validateRecognitionOptions } from './capabilities';
import { NativeInstance } from '../llm-native/instance';
export class NativeSpeechToTextBackend implements SpeechToTextBackend {
  readonly kind: 'offline' | 'online';
  constructor(private readonly instance: NativeInstance, readonly modelId: string) { this.kind = sttCapabilities(modelId).kind; }
  validate(options: RecognitionOptions) { validateRecognitionOptions(this.modelId, options); }
  configure(options: RecognitionOptions) { this.validate(options); return this.instance.call<void>('configure', { options }); }
  decode(samples: Float32Array) { return this.instance.call<TranscriptData>('transcribe', { samples: Array.from(samples) }); }
  openStream() { return this.instance.call<void>('openStream'); }
  pushStream(samples: Float32Array, finish = false) { return this.instance.call<{ text: string; isEndpoint: boolean }>('pushStream', { samples: Array.from(samples), finish }); }
  resetStream() { return this.instance.call<void>('resetStream'); }
  closeStream() { return this.instance.call<void>('closeStream'); }
  // Request rejections flow through the operation's existing partial-result failure path.
  setFailureHandler(_handler: (error: Error) => void): void {}
  unload() { return this.instance.unload(); }
}

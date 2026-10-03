import type { RecognitionOptions } from './types.js';
/** Native hotword syntax has score/control delimiters. Accept only the current
 * English tokenizer's alphabet, and normalize case before SentencePiece. */
export function normalizeZipformerHotwords(hotwords: readonly string[] | undefined): string[] {
  if (hotwords === undefined) return [];
  if (!Array.isArray(hotwords)) throw new TypeError('hotwords must be an array of strings.');
  return [...new Set(hotwords.map(word => {
    if (typeof word !== 'string' || !/^[a-zA-Z' \t]+$/.test(word) || !/[a-zA-Z]/.test(word)) throw new Error('Zipformer hotwords require English letters, apostrophes and spaces; blank phrases and decoder control syntax are unsupported.');
    return word.trim().replace(/[ \t]+/g, ' ').toUpperCase();
  }))];
}
export function sttCapabilities(modelId: string) {
  switch (modelId) {
    case 'openai/whisper-tiny-en': return { family: 'whisper', kind: 'offline', segmentTimestamps: true } as const;
    case 'UsefulSensors/moonshine-tiny': return { family: 'moonshine', kind: 'offline', segmentTimestamps: false } as const;
    case 'k2-fsa/streaming-zipformer-en': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false } as const;
    default: throw new Error(`Unsupported STT model: ${modelId}`);
  }
}
export function validateRecognitionOptions(modelId: string, options: RecognitionOptions): void {
  const capabilities = sttCapabilities(modelId);
  if (options.language !== undefined && (typeof options.language !== 'string' || !/^en(?:[-_][a-z0-9]{2,8})*$/i.test(options.language))) throw new Error(`${modelId} supports English only (language: en).`);
  if (options.task !== undefined && options.task !== 'transcribe') throw new Error(`${modelId} does not support task ${options.task}; only transcribe is supported.`);
  if (options.hotwords !== undefined) {
    if (modelId !== 'k2-fsa/streaming-zipformer-en') throw new Error(`${modelId} does not support hotwords.`);
    normalizeZipformerHotwords(options.hotwords);
  }
  if (options.timestamps !== undefined && (options.timestamps !== 'segment' || !capabilities.segmentTimestamps)) throw new Error(`${modelId} does not support requested ${options.timestamps} timestamps. Verified word spans are unavailable.`);
}

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
// Exact 99-code metadata from the pinned multilingual tiny/base/small exports.
// The .en export does not accept translation or other language tokens.
const WHISPER_LANGUAGES = new Set('sq ml de hi uz zh nl he sk gl lv ar tr haw gu si be bo tk sr mr pt mn sa tg pa sv as sl su ba hu ln br es ca bg hy th yo it da oc ro ta is bs cs lb my sd fo ne ha te mi cy el mg af yi kn ms so nn tt en tl pl ko az hr am id uk ps no eu kk km lo sn fr mk la jw fi bn lt vi ka mt sw ur ru ja fa ht et'.split(' '));
export function recognitionLanguage(language: string): string {
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(language)) throw new Error('language must be a supported language code (for example fr or zh-CN). Omit it for automatic detection.');
  return language.toLowerCase().split(/[-_]/)[0];
}
export function sttCapabilities(modelId: string) {
  switch (modelId) {
    case 'nvidia/parakeet-tdt-0.6b-v3': return { family: 'parakeet-tdt', kind: 'offline', segmentTimestamps: false, languages: 'auto', translation: false } as const;
    case 'openai/whisper-tiny-en': return { family: 'whisper', kind: 'offline', segmentTimestamps: true, languages: ['en'], translation: false } as const;
    case 'openai/whisper-tiny':
    case 'openai/whisper-base':
    case 'openai/whisper-small': return { family: 'whisper', kind: 'offline', segmentTimestamps: true, languages: 'multilingual', translation: true } as const;
    case 'UsefulSensors/moonshine-tiny': return { family: 'moonshine', kind: 'offline', segmentTimestamps: false, languages: ['en'], translation: false, moonshineVersion: 1 } as const;
    case 'moonshine-ai/moonshine-base': return { family: 'moonshine', kind: 'offline', segmentTimestamps: false, languages: ['en'], translation: false, moonshineVersion: 2 } as const;
    case 'k2-fsa/streaming-zipformer-en': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: ['en'], translation: false } as const;
    case 'shaojieli/streaming-zipformer-fr': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: ['fr'], translation: false } as const;
    case 'k2-fsa/streaming-zipformer-zh-en': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: ['zh', 'en'], translation: false } as const;
    default: throw new Error(`Unsupported STT model: ${modelId}`);
  }
}
export function validateRecognitionOptions(modelId: string, options: RecognitionOptions): void {
  const capabilities = sttCapabilities(modelId);
  if (options.language !== undefined) {
    if (capabilities.languages === 'auto') throw new Error(`${modelId} detects language automatically; forced language is unsupported.`);
    const language = recognitionLanguage(options.language);
    const supported = capabilities.languages === 'multilingual' ? WHISPER_LANGUAGES.has(language) : (capabilities.languages as readonly string[]).includes(language);
    if (!supported) throw new Error(`${modelId} does not support language ${options.language}.`);
    // Zipformer validates input-language compatibility only. Its bilingual
    // decoder remains bilingual; no language restriction is passed to native.
  }
  if (options.task !== undefined && options.task !== 'transcribe' && !(options.task === 'translate' && capabilities.translation)) throw new Error(`${modelId} does not support task ${options.task}; supported tasks: ${capabilities.translation ? 'transcribe, translate (to English)' : 'transcribe'}.`);
  if (options.hotwords !== undefined) {
    if (modelId !== 'k2-fsa/streaming-zipformer-en') throw new Error(`${modelId} does not support hotwords.`);
    normalizeZipformerHotwords(options.hotwords);
  }
  if (options.timestamps !== undefined && (options.timestamps !== 'segment' || !capabilities.segmentTimestamps)) throw new Error(`${modelId} does not support requested ${options.timestamps} timestamps. Verified word spans are unavailable.`);
}

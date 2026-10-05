import type { RecognitionOptions } from './types';
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
// The 99 language codes of the pinned tiny/base/small Whisper exports.
const whisperLanguages = new Set('hi cy oc so fr az eu ba no as nl bn es ml km mk sq mt et ms tr bg ps br ht tt tk la de ur ro fa uk mg lo sr yo id da pt nn sn sa sd gl ja pl ru ko ne kn zh be ca el it hu lt ta is jw fi bo sv mi hr bs yi sk lv af vi ha mn cs sl pa su ka ln lb sw en tl hy te he my haw fo kk si tg th ar am mr uz gu'.split(' '));
export function sttCapabilities(modelId: string) {
  switch (modelId) {
    case 'nvidia/parakeet-tdt-0.6b-v3': return { family: 'parakeet-tdt', kind: 'offline', segmentTimestamps: false, languages: 'auto', translate: false, hotwords: false } as const;
    case 'openai/whisper-tiny':
    case 'openai/whisper-base':
    case 'openai/whisper-small': return { family: 'whisper', kind: 'offline', segmentTimestamps: true, languages: 'whisper', translate: true, hotwords: false } as const;
    case 'openai/whisper-tiny-en': return { family: 'whisper', kind: 'offline', segmentTimestamps: true, languages: 'en', translate: false, hotwords: false } as const;
    case 'moonshine-ai/moonshine-base':
    case 'UsefulSensors/moonshine-tiny': return { family: 'moonshine', kind: 'offline', segmentTimestamps: false, languages: 'en', translate: false, hotwords: false } as const;
    case 'shaojieli/streaming-zipformer-fr': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: 'fr', translate: false, hotwords: false } as const;
    case 'k2-fsa/streaming-zipformer-zh-en': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: 'zh-en', translate: false, hotwords: false } as const;
    case 'k2-fsa/streaming-zipformer-en': return { family: 'zipformer-transducer', kind: 'online', segmentTimestamps: false, languages: 'en', translate: false, hotwords: true } as const;
    default: throw new Error(`Unsupported STT model: ${modelId}`);
  }
}
export function validateRecognitionOptions(modelId: string, options: RecognitionOptions): void {
  const capabilities = sttCapabilities(modelId);
  if (options.language !== undefined) {
    if (capabilities.languages === 'auto') throw new Error(`${modelId} detects language automatically; omit language.`);
    if (typeof options.language !== 'string' || !/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(options.language)) throw new Error('Invalid STT language code.');
    const language = options.language.toLowerCase().split(/[-_]/)[0]!;
    const supported = capabilities.languages === 'whisper' ? whisperLanguages.has(language) :
      capabilities.languages === 'zh-en' ? language === 'zh' || language === 'en' : language === capabilities.languages;
    if (!supported) throw new Error(`${modelId} is incompatible with language ${options.language}.`);
    // For Zipformers this is compatibility validation, not decoder forcing.
  }
  if (options.task !== undefined && options.task !== 'transcribe' && !(capabilities.translate && options.task === 'translate')) throw new Error(`${modelId} does not support task ${options.task}.`);
  if (options.hotwords !== undefined) {
    if (!capabilities.hotwords) throw new Error(`${modelId} does not support hotwords.`);
    normalizeZipformerHotwords(options.hotwords);
  }
  if (options.timestamps !== undefined && (options.timestamps !== 'segment' || !capabilities.segmentTimestamps)) throw new Error(`Requested ${options.timestamps} timestamps are not exposed by the RN adapter for ${modelId}.`);
}

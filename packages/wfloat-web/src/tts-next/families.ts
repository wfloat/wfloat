import type { PreparedUnit } from './backend-types.js';
import type { SpeechSegment } from './types.js';
import { validateSampling } from './pocket.js';

/** Internal asset contract. Registry keys are supplied by the parent rollout. */
export const STANDARD_TTS_MODELS = {
  'rhasspy/piper-en_US-lessac-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'en-us' },
  'rhasspy/piper-en_US-amy-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'en-us' },
  'rhasspy/piper-en_GB-alba-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'en-gb-x-rp' },
  'rhasspy/piper-de_DE-thorsten-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'de' },
  'rhasspy/piper-fr_FR-siwis-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'fr' },
  'rhasspy/piper-en_US-libritts-high': { family: 'piper', quant: 'fp32', speakers: 904, voice: 'en-us' },
  'rhasspy/piper-en_US-ryan-medium': { family: 'piper', quant: 'fp32', speakers: 1, voice: 'en-us' },
  'hexgrad/Kokoro-82M': { family: 'kokoro', quant: 'fp32', speakers: 54 },
  'KittenML/kitten-tts-nano-0.8': { family: 'kitten', quant: 'int8', speakers: 8 },
  'KittenML/kitten-tts-mini-0.8': { family: 'kitten', quant: 'int8-fp16', speakers: 8 },
} as const;
export type StandardModelId = keyof typeof STANDARD_TTS_MODELS;
export function standardModel(id: string) {
  return Object.prototype.hasOwnProperty.call(STANDARD_TTS_MODELS, id) ? STANDARD_TTS_MODELS[id as StandardModelId] : undefined;
}
export const KITTEN_VOICES = ['Jasper', 'Bella', 'Bruno', 'Luna', 'Hugo', 'Rosie', 'Leo', 'Kiki'] as const;
export const KITTEN_EXPORT_VOICES = ['expr-voice-2-m', 'expr-voice-2-f', 'expr-voice-3-m', 'expr-voice-3-f', 'expr-voice-4-m', 'expr-voice-4-f', 'expr-voice-5-m', 'expr-voice-5-f'] as const;
// Exact speaker order from the pinned 54-speaker export (GitHub asset 549865739).
export const KOKORO_VOICES = ('af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang em_santa').split(' ');
export type StandardConfig = {
  modelId: string;
  family: 'piper' | 'kokoro' | 'kitten';
  sampleRate: number;
  numSpeakers: number;
  voiceAliases: Record<string, number>;
  espeakVoice?: string;
  noiseScale?: number;
  noiseScaleW?: number;
  lengthScale: number;
};
export function standardConfig(id: string, configBytes?: Uint8Array): StandardConfig {
  const spec = standardModel(id);
  if (!spec) throw new Error(`Unsupported TTS model: ${id}`);
  if (spec.family === 'kitten') return { modelId: id, family: 'kitten', sampleRate: 24000, numSpeakers: 8,
    voiceAliases: Object.fromEntries([...KITTEN_VOICES.map((name, i) => [name, i]), ...KITTEN_EXPORT_VOICES.map((name, i) => [name, i])]), lengthScale: 1 };
  if (spec.family === 'kokoro') return { modelId: id, family: 'kokoro', sampleRate: 24000, numSpeakers: 54,
    voiceAliases: Object.fromEntries(KOKORO_VOICES.map((name, i) => [name, i])), lengthScale: 1 };
  if (spec.family !== 'piper' || !configBytes) throw new Error(`Missing Piper model_config for ${id}`);
  const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  if (c.audio?.sample_rate !== 22050 || c.num_speakers !== spec.speakers || c.espeak?.voice !== spec.voice || (c.phoneme_type ?? (id === 'rhasspy/piper-en_US-libritts-high' ? 'espeak' : undefined)) !== 'espeak') throw new Error(`Piper metadata does not match ${id}`);
  const aliases: Record<string, number> = Object.create(null);
  if (!c.speaker_id_map || typeof c.speaker_id_map !== 'object' || Array.isArray(c.speaker_id_map)) throw new Error('Invalid Piper speaker_id_map');
  for (const [name, value] of Object.entries(c.speaker_id_map)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= spec.speakers) throw new Error('Invalid Piper speaker_id_map');
    aliases[name] = value;
  }
  for (const key of ['noise_scale', 'noise_w', 'length_scale']) {
    if (typeof c.inference?.[key] !== 'number' || !Number.isFinite(c.inference[key]) || c.inference[key] <= 0) throw new Error(`Invalid Piper ${key}`);
  }
  return { modelId: id, family: 'piper', sampleRate: 22050, numSpeakers: spec.speakers, voiceAliases: aliases,
    espeakVoice: spec.voice, noiseScale: c.inference.noise_scale, noiseScaleW: c.inference.noise_w, lengthScale: c.inference.length_scale };
}
export function standardVoice(config: StandardConfig, voiceId: SpeechSegment['voiceId']): number {
  const sid = voiceId === undefined ? 0 : typeof voiceId === 'string' && Object.prototype.hasOwnProperty.call(config.voiceAliases, voiceId) ? config.voiceAliases[voiceId] : voiceId;
  if (typeof sid !== 'number' || !Number.isInteger(sid) || sid < 0 || sid >= config.numSpeakers) throw new RangeError(`Invalid ${config.modelId} voiceId: ${String(voiceId)}`);
  if (config.family === 'kokoro') kokoroLanguage(sid);
  return sid;
}
export function kokoroLanguage(sid: number): string {
  const voice = KOKORO_VOICES[sid];
  if (!voice) throw new RangeError('Invalid Kokoro voiceId');
  if (voice[0] === 'j') throw new Error('Kokoro Japanese voices require a Japanese frontend; the current Sherpa frontend routes Han characters through the Chinese lexicon.');
  // Prefixes are Kokoro language codes, not arbitrary speaker-to-language guesses.
  return ({ a: 'en-us', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', p: 'pt', z: 'cmn' } as Record<string, string>)[voice[0]];
}
export function validateStandardSegment(config: StandardConfig, segment: SpeechSegment) {
  validateSampling(segment);
  if (segment.text.includes('\0')) throw new TypeError('Speech text must not contain NUL characters.');
  if (segment.referenceAudio !== undefined) throw new TypeError('This model does not support referenceAudio.');
  standardVoice(config, segment.voiceId);
  if (segment.speed !== undefined && (!Number.isFinite(segment.speed) || segment.speed <= 0 || !Number.isFinite(Math.fround(segment.speed)) || Math.fround(segment.speed) === 0)) throw new RangeError('TTS speed must be finite, positive and representable as float32.');
}
/** Only segment original text. Normalization/phonemization belong to the actual
 * Piper or Kokoro frontend, never the Wfloat expressive English cleaner. */
export function prepareStandard(config: StandardConfig, segment: SpeechSegment): PreparedUnit[] {
  validateStandardSegment(config, segment);
  if (config.family === 'kitten') {
    // The shared version-8 engine owns upstream normalization and chunking.
    // Splitting raw UTF-16 here can cut currencies, contractions or URLs and
    // change style rows. Keep one source range for this completed audio unit.
    if ([...segment.text].length > 65536) throw new RangeError('Kitten text exceeds 65536 codepoints per call.');
    return segment.text.trim() ? [{ text: segment.text, textStart: 0, textEnd: segment.text.length }] : [];
  }
  const units: PreparedUnit[] = [];
  let start = 0, textStart = 0;
  while (start < segment.text.length) {
    let end = Math.min(start + 200, segment.text.length);
    if (end < segment.text.length) {
      const window = segment.text.slice(start, end);
      const boundaries = [...window.matchAll(/[.!?。！？](?:\s+|$)|\s+/gu)].filter(m => m.index! > 0);
      const last = boundaries[boundaries.length - 1];
      if (last) end = start + last.index! + last[0].length;
      else if (/^[\uDC00-\uDFFF]$/.test(segment.text[end])) end--;
    }
    const text = segment.text.slice(start, end);
    if (text.trim()) { units.push({ text, textStart, textEnd: end }); textStart = end; }
    else if (units.length) { units[units.length - 1].textEnd = end; textStart = end; }
    start = end;
  }
  return units;
}

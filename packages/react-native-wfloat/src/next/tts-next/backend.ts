import { prepareStandard, standardVoice, validateStandardSegment, type StandardConfig } from './families';
import { normalizeReferenceAudio, validateReferenceAudio } from './pocket-audio';
import { SPEAKER_IDS, VALID_EMOTIONS } from './catalog';
import type { PreparedUnit, TextToSpeechBackend } from './backend-types';
import type { SpeechSegment } from './types';
import { NativeInstance } from '../llm-native/instance';
export function voiceNumber(voiceId: string | number | undefined): number {
  if (voiceId === undefined) return 0;
  if (typeof voiceId === 'number' && Number.isInteger(voiceId) && voiceId >= 0 && voiceId < 20) return voiceId;
  if (typeof voiceId === 'string' && Object.prototype.hasOwnProperty.call(SPEAKER_IDS, voiceId)) return SPEAKER_IDS[voiceId]!;
  throw new RangeError(`Invalid Wfloat voiceId: ${String(voiceId)}`);
}
export function validateSampling(segment: SpeechSegment) {
  if (segment.temperature !== undefined && (typeof segment.temperature !== 'number' || !Number.isFinite(Math.fround(segment.temperature)) || segment.temperature < 0 || (segment.temperature > 0 && segment.temperature < 2 ** -126))) throw new RangeError('temperature must be finite, nonnegative float32 with positive values at least 2**-126.');
  for (const [name, value, minimum] of [['seed', segment.seed, 0], ['inferenceSteps', segment.inferenceSteps, 1]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > 2147483647)) throw new RangeError(`${name} must be an int32 >= ${minimum}.`);
  }
}
export function validateWfloatSegment(segment: SpeechSegment) {
  if (segment.referenceAudio !== undefined) throw new TypeError('Wfloat TTS does not support referenceAudio.');
  validateSampling(segment);
  voiceNumber(segment.voiceId);
  if (segment.emotion !== undefined && !(VALID_EMOTIONS as readonly string[]).includes(segment.emotion)) throw new RangeError(`Invalid Wfloat emotion: ${segment.emotion}`);
  if (segment.intensity !== undefined && (!Number.isFinite(segment.intensity) || segment.intensity < 0 || segment.intensity > 1)) throw new RangeError('Wfloat intensity must be between 0 and 1.');
  if (segment.speed !== undefined && (!Number.isFinite(segment.speed) || segment.speed <= 0)) throw new RangeError('Wfloat speed must be finite and positive.');
}

export class NativeTextToSpeechBackend implements TextToSpeechBackend {
  private warnedSampling = false;
  constructor(private readonly instance: NativeInstance, readonly sampleRate: number) {}
  validate(segment: SpeechSegment) {
    validateWfloatSegment(segment);
    if (!this.warnedSampling && (segment.temperature !== undefined || segment.seed !== undefined || segment.inferenceSteps !== undefined)) {
      this.warnedSampling = true;
      console.warn('Wfloat TTS does not support temperature, seed, or inferenceSteps; explicit values are ignored.');
    }
  }
  prepare(segment: SpeechSegment) {
    this.validate(segment);
    return this.instance.call<PreparedUnit[]>('prepare', { text: segment.text, emotion: segment.emotion ?? 'neutral', intensity: segment.intensity ?? 0.5 });
  }
  async synthesize(unit: PreparedUnit, segment: SpeechSegment) {
    const audio = await this.instance.call<{ samples: number[]; sampleRate: number }>('synthesize', {
      text: unit.text, voiceId: voiceNumber(segment.voiceId), speed: segment.speed ?? 1,
    });
    if (audio.sampleRate !== this.sampleRate || !Array.isArray(audio.samples) || audio.samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid native synthesized audio.');
    return { samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate };
  }
  unload() { return this.instance.unload(); }
}

export function validatePocketSegment(segment: SpeechSegment) {
  if (segment.voiceId !== undefined && segment.referenceAudio !== undefined) throw new TypeError('Pocket voiceId and referenceAudio are mutually exclusive.');
  if (segment.voiceId !== undefined && segment.voiceId !== 'alba') throw new RangeError('Pocket voiceId must be alba.');
  validateSampling(segment);
  if (segment.referenceAudio !== undefined) {
    validateReferenceAudio(segment.referenceAudio);
  }
}

export class NativePocketTextToSpeechBackend implements TextToSpeechBackend {
  private warnedUnsupported = false;
  private references = new WeakMap<NonNullable<SpeechSegment['referenceAudio']>, Promise<{ samples: Float32Array; sampleRate: number }>>();
  constructor(private readonly instance: NativeInstance, readonly sampleRate: number) {}
  validate(segment: SpeechSegment) {
    validatePocketSegment(segment);
    if (!this.warnedUnsupported && (segment.emotion !== undefined || segment.intensity !== undefined || segment.speed !== undefined)) {
      this.warnedUnsupported = true;
      console.warn('Pocket TTS does not support emotion, intensity, or speed; explicit values are ignored.');
    }
  }
  prepare(segment: SpeechSegment) {
    return this.instance.call<PreparedUnit[]>('prepare', { text: segment.text });
  }
  async synthesize(unit: PreparedUnit, segment: SpeechSegment) {
    let referenceAudio;
    if (segment.referenceAudio !== undefined) {
      let pending = this.references.get(segment.referenceAudio);
      if (!pending) { pending = normalizeReferenceAudio(segment.referenceAudio); this.references.set(segment.referenceAudio, pending); }
      const pcm = await pending;
      referenceAudio = { samples: Array.from(pcm.samples), sampleRate: pcm.sampleRate };
    }
    const audio = await this.instance.call<{ samples: number[]; sampleRate: number }>('synthesize', {
      text: unit.text, voiceId: segment.voiceId, referenceAudio,
      temperature: segment.temperature ?? 0.7, seed: segment.seed, inferenceSteps: segment.inferenceSteps ?? 5,
    });
    if (audio.sampleRate !== this.sampleRate || !Array.isArray(audio.samples) || audio.samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid native synthesized audio.');
    return { samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate };
  }
  unload() {
    this.references = new WeakMap();
    return this.instance.unload();
  }
}

/** Piper/Kokoro/Kitten use their own frontend; original text never enters Wfloat's cleaner. */
export class NativeStandardTextToSpeechBackend implements TextToSpeechBackend {
  private warnedUnsupported = false;
  readonly sampleRate: number;
  constructor(private readonly instance: NativeInstance, private readonly config: StandardConfig) { this.sampleRate = config.sampleRate; }
  validate(segment: SpeechSegment) {
    validateStandardSegment(this.config, segment);
    if (!this.warnedUnsupported && [segment.emotion, segment.intensity, segment.temperature, segment.seed, segment.inferenceSteps].some(v => v !== undefined)) {
      this.warnedUnsupported = true;
      console.warn('This TTS model does not support emotion, intensity, temperature, seed, or inferenceSteps; explicit values are ignored.');
    }
  }
  async prepare(segment: SpeechSegment) { this.validate(segment); return prepareStandard(this.config, segment); }
  async synthesize(unit: PreparedUnit, segment: SpeechSegment) {
    this.validate(segment);
    const audio = await this.instance.call<{ samples: number[]; sampleRate: number }>('synthesize', {
      text: unit.text, voiceId: standardVoice(this.config, segment.voiceId), speed: segment.speed ?? 1,
    });
    if (audio.sampleRate !== this.sampleRate || !Array.isArray(audio.samples) || audio.samples.some(sample => !Number.isFinite(sample))) throw new Error('Invalid native synthesized audio.');
    if (this.config.family === 'kitten' && !audio.samples.length) throw new Error('Kitten synthesis returned empty audio.');
    return { samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate };
  }
  unload() { return this.instance.unload(); }
}

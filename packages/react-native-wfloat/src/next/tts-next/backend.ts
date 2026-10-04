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
export function validateWfloatSegment(segment: SpeechSegment) {
  voiceNumber(segment.voiceId);
  if (segment.emotion !== undefined && !(VALID_EMOTIONS as readonly string[]).includes(segment.emotion)) throw new RangeError(`Invalid Wfloat emotion: ${segment.emotion}`);
  if (segment.intensity !== undefined && (!Number.isFinite(segment.intensity) || segment.intensity < 0 || segment.intensity > 1)) throw new RangeError('Wfloat intensity must be between 0 and 1.');
  if (segment.speed !== undefined && (!Number.isFinite(segment.speed) || segment.speed <= 0)) throw new RangeError('Wfloat speed must be finite and positive.');
}

export class NativeTextToSpeechBackend implements TextToSpeechBackend {
  constructor(private readonly instance: NativeInstance, readonly sampleRate: number) {}
  validate(segment: SpeechSegment) { validateWfloatSegment(segment); }
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

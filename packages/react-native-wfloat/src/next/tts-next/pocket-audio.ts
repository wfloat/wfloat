import { StreamingResampler } from '../stt-next/audio';
import type { PcmAudio, TranscriptionAudio } from '../stt-next/types';
import { request } from '../platform/bridge';

export function validateReferenceDuration(audio: PcmAudio) {
  if (audio.samples.length / audio.sampleRate > 10) throw new RangeError('Pocket referenceAudio must not exceed 10 seconds.');
}

/** Validate without allocating another copy of the operation-owned snapshot. */
export function validateReferenceAudio(input: TranscriptionAudio): void {
  if (!input || typeof input !== 'object') throw new TypeError('Expected reference audio.');
  if ('uri' in input) {
    if (typeof input.uri !== 'string' || !/^(file|content):\/\//.test(input.uri)) throw new TypeError('Audio URI must use file:// or content://.');
    return;
  }
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) throw new TypeError('sampleRate must be positive and finite.');
  if (Object.prototype.toString.call(input.samples) !== '[object Float32Array]' || !input.samples.length) throw new TypeError('Audio samples must be a nonempty Float32Array.');
  validateReferenceDuration(input);
  for (const value of input.samples) if (!Number.isFinite(value)) throw new TypeError('Audio samples must be finite.');
}

/** Normalize an operation-owned snapshot; never modify its samples. URI decoding is mono. */
export async function normalizeReferenceAudio(input: TranscriptionAudio): Promise<PcmAudio> {
  const decoded = 'uri' in input
    ? await request<{ samples: number[]; sampleRate: number }>({ op: 'decodeAudio', uri: input.uri })
    : undefined;
  const pcm = (decoded ? { samples: Float32Array.from(decoded.samples), sampleRate: decoded.sampleRate } : input) as PcmAudio;
  validateReferenceAudio(pcm);
  if (pcm.sampleRate === 24_000) return pcm;
  const resampler = new StreamingResampler(24_000);
  const body = resampler.push(pcm), tail = resampler.finish();
  const samples = new Float32Array(body.length + tail.length);
  samples.set(body); samples.set(tail, body.length);
  return { samples, sampleRate: 24_000 };
}

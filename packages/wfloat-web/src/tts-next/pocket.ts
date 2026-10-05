import type { PreparedUnit } from './backend-types.js';
import type { SpeechSegment } from './types.js';

export function validateSampling(segment: SpeechSegment) {
  if (segment.temperature !== undefined && (!Number.isFinite(segment.temperature) || segment.temperature < 0 || !Number.isFinite(Math.fround(segment.temperature)) || (segment.temperature > 0 && segment.temperature < 2 ** -126))) throw new RangeError('temperature must be finite, nonnegative and representable as a normal float32 (or zero).');
  if (segment.seed !== undefined && (!Number.isInteger(segment.seed) || segment.seed < 0 || segment.seed > 2147483647)) throw new RangeError('seed must be an integer between 0 and 2147483647.');
  if (segment.inferenceSteps !== undefined && (!Number.isInteger(segment.inferenceSteps) || segment.inferenceSteps < 1 || segment.inferenceSteps > 2147483647)) throw new RangeError('inferenceSteps must be a positive int32.');
}
export function validatePocketSegment(segment: SpeechSegment) {
  validateSampling(segment);
  if (segment.text.includes('\0')) throw new TypeError('Speech text must not contain NUL characters.');
  if (segment.referenceAudio !== undefined && segment.voiceId !== undefined) throw new TypeError('Use either referenceAudio or voiceId, not both.');
  if (segment.voiceId !== undefined && segment.voiceId !== 'alba') throw new RangeError('Pocket TTS voiceId must be "alba"; use referenceAudio for another voice.');
  const reference = segment.referenceAudio;
  if (reference && 'samples' in reference && reference.samples.length / reference.sampleRate > 10) throw new RangeError('Pocket referenceAudio must be at most 10 seconds.');
}
/** Bounded speech units preserve original UTF-16 offsets, including whitespace.
 * The engine has a finite latent budget per sentence, so never pass unbounded text. */
export function preparePocket(segment: SpeechSegment): PreparedUnit[] {
  validatePocketSegment(segment);
  const units: PreparedUnit[] = [];
  let start = 0;
  let textStart = 0;
  while (start < segment.text.length) {
    let end = Math.min(start + 200, segment.text.length);
    if (end < segment.text.length) {
      const window = segment.text.slice(start, end);
      const boundaries = [...window.matchAll(/[.!?](?:\s+|$)|\s+/gu)];
      const valid = boundaries.filter(match => match.index! > 0);
      const last = valid[valid.length - 1];
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

import type { PcmAudio, TranscriptionAudio } from './types.js';

function validateRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError('sampleRate must be positive and finite');
}

function validateSamples(samples: Float32Array, allowEmpty = false): void {
  if (Object.prototype.toString.call(samples) !== '[object Float32Array]' || (!allowEmpty && !samples.length)) {
    throw new TypeError('Audio samples must be a nonempty Float32Array');
  }
  for (const sample of samples) if (!Number.isFinite(sample)) throw new TypeError('Audio samples must be finite');
}

/** Capture caller PCM without modifying or detaching its buffer. */
export function snapshotPcm(input: PcmAudio): PcmAudio {
  if (!input) throw new TypeError('Expected PCM audio');
  const sampleRate = input.sampleRate;
  validateRate(sampleRate);
  const source = input.samples;
  validateSamples(source);
  const samples = new Float32Array(source);
  validateSamples(samples);
  return { samples, sampleRate };
}

function downmix(input: AudioBuffer): PcmAudio {
  validateRate(input.sampleRate);
  if (!Number.isInteger(input.numberOfChannels) || input.numberOfChannels < 1 ||
      !Number.isInteger(input.length) || input.length < 1) throw new TypeError('Invalid AudioBuffer dimensions');
  const channels = Array.from({ length: input.numberOfChannels }, (_, i) => input.getChannelData(i));
  for (const channel of channels) {
    validateSamples(channel);
    if (channel.length !== input.length) throw new TypeError('Invalid AudioBuffer channel length');
  }
  const samples = new Float32Array(input.length);
  for (let i = 0; i < samples.length; i++) {
    let value = 0;
    for (const channel of channels) value += channel[i] / channels.length;
    samples[i] = value;
  }
  validateSamples(samples);
  return { samples, sampleRate: input.sampleRate };
}

/** Synchronous ownership boundary. Blobs are immutable and can be retained directly. */
export function snapshotAudio(input: TranscriptionAudio): PcmAudio | Blob {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input;
  if (input && typeof (input as AudioBuffer).getChannelData === 'function') return downmix(input as AudioBuffer);
  return snapshotPcm(input as PcmAudio);
}

/**
 * Streaming mono PCM to a fixed output rate (16 kHz by default).
 * push(audio) synchronously consumes samples and returns owned output. No input
 * buffer is retained. Same-rate pushes share fractional phase even for tiny chunks.
 * A source-rate change starts a new timeline: the old timeline's final sample is
 * extended to its duration boundary and its tail precedes the new output.
 * Each contiguous rate run produces ceil(inputLength * outputRate / inputRate)
 * samples, so rate changes can each add less than one output sample of rounding.
 * finish() flushes the final tail and is idempotent; push after finish rejects.
 * Invalid/empty PCM rejects without changing state. Downsampling uses a centered
 * Blackman-windowed sinc low-pass filter, with bounded lookahead/history; callers
 * must consume finish() to receive the delayed tail. Upsampling is linear.
 * Filter cutoff is 90% of output Nyquist, radius is 24 source/output ratios
 * (capped at 1024 source samples), and fractional kernels use 256 phases. The
 * radius cap limits rejection quality for extreme ratios above roughly 42:1.
 */
export class StreamingResampler {
  private stream?: FixedRateResampler;
  private ended = false;
  constructor(readonly outputSampleRate = 16_000) {
    validateRate(outputSampleRate);
  }
  push(audio: PcmAudio): Float32Array {
    if (this.ended) throw new Error('Resampler has been finished');
    if (!audio) throw new TypeError('Expected PCM audio');
    const { samples, sampleRate } = audio;
    validateRate(sampleRate);
    validateSamples(samples);
    let tail: Float32Array = new Float32Array(0);
    if (this.stream?.inputSampleRate !== sampleRate) {
      if (this.stream) tail = this.stream.flush();
      this.stream = new FixedRateResampler(sampleRate, this.outputSampleRate);
    }
    const body = this.stream.push(samples);
    if (!tail.length) return body;
    const output = new Float32Array(tail.length + body.length);
    output.set(tail);
    output.set(body, tail.length);
    return output;
  }
  finish(): Float32Array {
    if (this.ended) return new Float32Array(0);
    this.ended = true;
    return this.stream?.flush() ?? new Float32Array(0);
  }
}

/** Bounded history and lazy phase kernels; never retains caller sample buffers. */
class FixedRateResampler {
  private total = 0;
  private emitted = 0;
  private first = 0;
  private last = 0;
  private ended = false;
  private readonly radius: number;
  private readonly history: Float32Array;
  private historyLength = 0;
  private readonly kernels = new Map<number, Float64Array>();
  constructor(readonly inputSampleRate: number, readonly outputSampleRate: number) {
    const ratio = inputSampleRate / outputSampleRate;
    this.radius = ratio > 1 ? Math.min(1024, Math.ceil(24 * ratio)) : 0;
    this.history = new Float32Array(2 * this.radius + 2);
  }
  private kernel(fraction: number): Float64Array {
    const phase = Math.floor(fraction * 256);
    const cached = this.kernels.get(phase);
    if (cached) return cached;
    const weights = new Float64Array(2 * this.radius + 1);
    const cutoff = 0.9 * this.outputSampleRate / this.inputSampleRate;
    let sum = 0;
    for (let j = -this.radius; j <= this.radius; j++) {
      const x = j - phase / 256;
      const z = Math.PI * cutoff * x;
      const sinc = z === 0 ? 1 : Math.sin(z) / z;
      const window = Math.abs(x) > this.radius ? 0 :
        0.42 + 0.5 * Math.cos(Math.PI * x / this.radius) + 0.08 * Math.cos(2 * Math.PI * x / this.radius);
      const weight = cutoff * sinc * window;
      weights[j + this.radius] = weight;
      sum += weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    this.kernels.set(phase, weights);
    return weights;
  }
  // final=true is also the full-file path: allocate exactly one output buffer.
  push(samples: Float32Array, final = false): Float32Array {
    if (this.ended) throw new Error('Resampler has been flushed');
    const start = this.total;
    const end = start + samples.length;
    if (!start && samples.length) this.first = samples[0];
    if (samples.length) this.last = samples[samples.length - 1];
    const position = (index: number) => index * this.inputSampleRate / this.outputSampleRate;
    let limit: number;
    if (final) limit = Math.ceil(end * this.outputSampleRate / this.inputSampleRate);
    else {
      const boundary = end - 1 - this.radius;
      limit = Math.max(this.emitted, Math.floor(boundary * this.outputSampleRate / this.inputSampleRate) + 1);
      // Keep allocation and iteration consistent at floating-point boundaries.
      while (limit > this.emitted && position(limit - 1) > boundary) limit--;
      while (position(limit) <= boundary) limit++;
    }
    const output = new Float32Array(Math.max(0, limit - this.emitted));
    const read = (index: number): number => {
      if (index < 0) return this.first;
      if (index >= end) return this.last;
      if (index >= start) return samples[index - start];
      return this.history[index - (start - this.historyLength)];
    };
    for (let i = 0; i < output.length; i++) {
      const pos = position(this.emitted++);
      const left = Math.floor(pos);
      const fraction = pos - left;
      if (this.radius) {
        const weights = this.kernel(fraction);
        let value = 0;
        for (let j = -this.radius; j <= this.radius; j++) value += read(left + j) * weights[j + this.radius];
        output[i] = value;
      } else {
        const a = read(left);
        output[i] = a + (read(left + 1) - a) * fraction;
      }
    }
    this.total = end;
    if (final) { this.ended = true; this.kernels.clear(); }
    else if (samples.length >= this.history.length) {
      this.history.set(samples.subarray(samples.length - this.history.length));
      this.historyLength = this.history.length;
    } else {
      const retained = Math.min(this.historyLength, this.history.length - samples.length);
      this.history.copyWithin(0, this.historyLength - retained, this.historyLength);
      this.history.set(samples, retained);
      this.historyLength = retained + samples.length;
    }
    return output;
  }
  flush(): Float32Array {
    if (this.ended) return new Float32Array(0);
    return this.push(new Float32Array(0), true);
  }
}

/**
 * Normalize an SDK-owned snapshot to mono 16 kHz. PCM ownership must already have
 * been secured by snapshotAudio/snapshotPcm at the public invocation boundary.
 * Already-normalized PCM is returned directly; other rates allocate one result
 * buffer plus bounded filter state, without another full input/output copy.
 */
export async function normalizeAudio(snapshot: PcmAudio | Blob): Promise<PcmAudio> {
  let pcm: PcmAudio;
  if (typeof Blob !== 'undefined' && snapshot instanceof Blob) {
    if (!snapshot.size) throw new TypeError('Audio Blob must not be empty');
    const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error('Audio decoding requires Web Audio');
    const context = new Context();
    try {
      pcm = downmix(await context.decodeAudioData(await snapshot.arrayBuffer()));
    } finally {
      await context.close();
    }
  } else {
    pcm = snapshot as PcmAudio;
    if (!pcm) throw new TypeError('Expected PCM audio');
    validateRate(pcm.sampleRate);
    validateSamples(pcm.samples);
  }
  if (pcm.sampleRate === 16_000) return pcm;
  const resampler = new FixedRateResampler(pcm.sampleRate, 16_000);
  return { samples: resampler.push(pcm.samples, true), sampleRate: 16_000 };
}

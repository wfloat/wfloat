import { createMicrophoneCapture, type MicrophoneCapture } from "../audio/microphone.js";
import { VadWorkerBridge } from "../worker/vadWorkerBridge.js";
import type {
  DecodedVadAudio,
  LoadVadModelOptions,
  VadDetectOptions,
  VadDetectionResult,
  VadMicrophoneCaptureResult,
  VadMicrophoneOptions,
  VadSessionOptions,
} from "./types.js";

const TARGET_SAMPLE_RATE = 16000;

function downmixToMono(audioBuffer: AudioBuffer): Float32Array {
  if (audioBuffer.numberOfChannels <= 1) {
    return new Float32Array(audioBuffer.getChannelData(0));
  }

  const samples = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < channelData.length; i += 1) {
      samples[i] += channelData[i];
    }
  }

  const scale = 1 / audioBuffer.numberOfChannels;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= scale;
  }

  return samples;
}

function resampleLinear(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (inputSampleRate <= 0 || outputSampleRate <= 0 || samples.length === 0) {
    return samples;
  }

  if (inputSampleRate === outputSampleRate) {
    return new Float32Array(samples);
  }

  const outputLength = Math.max(1, Math.round((samples.length * outputSampleRate) / inputSampleRate));
  const output = new Float32Array(outputLength);
  const scale = inputSampleRate / outputSampleRate;

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * scale;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const mix = sourceIndex - leftIndex;
    output[i] = samples[leftIndex] * (1 - mix) + samples[rightIndex] * mix;
  }

  return output;
}

async function decodeArrayBufferAudio(audioData: ArrayBuffer): Promise<DecodedVadAudio> {
  if (typeof AudioContext === "undefined") {
    throw new Error("AudioContext is not available in this environment.");
  }

  const audioContext = new AudioContext();

  try {
    const decoded = await audioContext.decodeAudioData(audioData.slice(0));
    return {
      samples: downmixToMono(decoded),
      sampleRate: decoded.sampleRate,
    };
  } finally {
    await audioContext.close();
  }
}

async function normalizeAudioInput(options: VadDetectOptions): Promise<DecodedVadAudio> {
  const audio = options.audio;

  if (audio instanceof Float32Array) {
    if (typeof options.sampleRate !== "number" || !Number.isFinite(options.sampleRate)) {
      throw new Error("sampleRate is required when audio is a Float32Array.");
    }

    return {
      samples: resampleLinear(audio, options.sampleRate, TARGET_SAMPLE_RATE),
      sampleRate: TARGET_SAMPLE_RATE,
    };
  }

  if (typeof AudioBuffer !== "undefined" && audio instanceof AudioBuffer) {
    return {
      samples: resampleLinear(downmixToMono(audio), audio.sampleRate, TARGET_SAMPLE_RATE),
      sampleRate: TARGET_SAMPLE_RATE,
    };
  }

  const arrayBuffer = audio instanceof Blob ? await audio.arrayBuffer() : (audio as ArrayBuffer);
  const decoded = await decodeArrayBufferAudio(arrayBuffer);
  return {
    samples: resampleLinear(decoded.samples, decoded.sampleRate, TARGET_SAMPLE_RATE),
    sampleRate: TARGET_SAMPLE_RATE,
  };
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples.length);
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  return typeof sampleRate === "number" && Number.isFinite(sampleRate)
    ? Math.max(1, Math.trunc(sampleRate))
    : TARGET_SAMPLE_RATE;
}

export class VadSession {
  private microphoneCapture: MicrophoneCapture | null = null;
  private microphoneQueue: Promise<void> = Promise.resolve();
  private microphoneChunkCount = 0;
  private microphoneStartedAt = 0;
  private emittedWindowCount = 0;
  private speechStartCount = 0;
  private speechEndCount = 0;
  private maxRms = 0;

  constructor(
    public readonly modelId: string,
    private readonly sessionId: number,
    private readonly options: VadSessionOptions,
  ) {}

  async startMicrophone(options: VadMicrophoneOptions = {}): Promise<void> {
    if (this.microphoneCapture?.isRecording) {
      return;
    }

    await VadWorkerBridge.resetSession(this.sessionId);
    const capture = await createMicrophoneCapture({
      sampleRate: normalizeSampleRate(options.sampleRate),
    });

    this.microphoneQueue = Promise.resolve();
    this.microphoneChunkCount = 0;
    this.microphoneStartedAt = performance.now();
    this.emittedWindowCount = 0;
    this.speechStartCount = 0;
    this.speechEndCount = 0;
    this.maxRms = 0;

    try {
      await capture.start({
        onChunk: (samples, sampleRate) => {
          this.microphoneChunkCount += 1;
          const normalizedSamples = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
          this.maxRms = Math.max(this.maxRms, rms(normalizedSamples));
          this.microphoneQueue = this.microphoneQueue.then(async () => {
            const result = await VadWorkerBridge.pushSessionAudio({
              sessionId: this.sessionId,
              samples: normalizedSamples,
              sampleRate: TARGET_SAMPLE_RATE,
            });
            this.emittedWindowCount = result.emittedWindowCount;
            this.speechStartCount = result.speechStartCount;
            this.speechEndCount = result.speechEndCount;

            for (const event of result.speechStarts) {
              await this.options.onSpeechStart?.(event);
            }
            for (const segment of result.segments) {
              await this.options.onSpeechEnd?.(segment);
            }
          });
        },
      });
      this.microphoneCapture = capture;
    } catch (error) {
      await capture.close().catch(() => {});
      throw error;
    }
  }

  async stopMicrophone(): Promise<VadMicrophoneCaptureResult> {
    if (!this.microphoneCapture?.isRecording) {
      throw new Error("Live VAD microphone capture is not active.");
    }

    const capture = this.microphoneCapture;
    this.microphoneCapture = null;
    const recorded = await capture.stop();
    await this.microphoneQueue;
    const finalResult = await VadWorkerBridge.finishSession(this.sessionId);

    this.emittedWindowCount = finalResult.emittedWindowCount;
    this.speechStartCount = finalResult.speechStartCount;
    this.speechEndCount = finalResult.speechEndCount;

    for (const segment of finalResult.segments) {
      await this.options.onSpeechEnd?.(segment);
    }

    return {
      durationMs:
        this.microphoneStartedAt > 0
          ? Math.max(1, Math.round(performance.now() - this.microphoneStartedAt))
          : Math.round(recorded.durationSec * 1000),
      sampleRate: TARGET_SAMPLE_RATE,
      chunkCount: this.microphoneChunkCount,
      emittedWindowCount: this.emittedWindowCount,
      speechStartCount: this.speechStartCount,
      speechEndCount: this.speechEndCount,
      maxRms: this.maxRms,
    };
  }

  async reset(): Promise<void> {
    await VadWorkerBridge.resetSession(this.sessionId);
  }

  async close(): Promise<void> {
    if (this.microphoneCapture) {
      await this.microphoneCapture.close().catch(() => {});
      this.microphoneCapture = null;
    }
    await VadWorkerBridge.closeSession(this.sessionId);
  }
}

export class VadModel {
  private constructor(
    public readonly modelId: string,
    public readonly family: string,
  ) {}

  static async load(modelId: string, options: LoadVadModelOptions = {}): Promise<VadModel> {
    const response = await VadWorkerBridge.loadModel(
      {
        modelId,
        threshold: options.threshold,
        minSilenceDurationSec: options.minSilenceDurationSec,
        minSpeechDurationSec: options.minSpeechDurationSec,
        maxSpeechDurationSec: options.maxSpeechDurationSec,
      },
      (message) => {
        options.onProgress?.(message.event);
      },
    );

    options.onProgress?.({ status: "completed" });

    return new VadModel(modelId, response.family);
  }

  async detect(options: VadDetectOptions): Promise<VadDetectionResult> {
    const normalized = await normalizeAudioInput(options);
    return VadWorkerBridge.detect({
      samples: normalized.samples,
      sampleRate: normalized.sampleRate,
    });
  }

  async createSession(options: VadSessionOptions = {}): Promise<VadSession> {
    const sessionId = await VadWorkerBridge.createSession();
    return new VadSession(this.modelId, sessionId, options);
  }
}

export async function loadVadModel(
  modelId: string,
  options: LoadVadModelOptions = {},
): Promise<VadModel> {
  return VadModel.load(modelId, options);
}

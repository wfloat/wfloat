import { createMicrophoneCapture, type MicrophoneCapture } from "../audio/microphone.js";
import { SttWorkerBridge } from "../worker/sttWorkerBridge.js";
import type {
  DecodedAudio,
  LoadSttModelOptions,
  SttMicrophoneCaptureResult,
  SttMicrophoneOptions,
  SttMicrophoneRecording,
  SttMicrophoneRecordingOptions,
  StreamingTranscribeChunk,
  StreamingTranscriptionResult,
  TranscribeOptions,
  TranscriptionResult,
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

async function decodeArrayBufferAudio(audioData: ArrayBuffer): Promise<DecodedAudio> {
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

async function normalizeAudioInput(options: TranscribeOptions): Promise<DecodedAudio> {
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

export class SttModel {
  private microphoneCapture: MicrophoneCapture | null = null;

  private constructor(
    public readonly modelId: string,
    public readonly family: string,
    public readonly supportsStreaming: boolean,
  ) {}

  static async load(modelId: string, options: LoadSttModelOptions = {}): Promise<SttModel> {
    const response = await SttWorkerBridge.loadModel(
      {
        modelId,
        language: options.language,
        task: options.task,
      },
      (message) => {
        options.onProgress?.(message.event);
      },
    );

    options.onProgress?.({ status: "completed" });

    return new SttModel(modelId, response.family, response.supportsStreaming);
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    const normalized = await normalizeAudioInput(options);
    return SttWorkerBridge.transcribe({
      samples: normalized.samples,
      sampleRate: normalized.sampleRate,
    });
  }

  async startMicrophone(options: SttMicrophoneRecordingOptions = {}): Promise<void> {
    if (this.microphoneCapture?.isRecording) {
      return;
    }

    const capture = await createMicrophoneCapture({
      sampleRate: normalizeSampleRate(options.sampleRate),
    });

    try {
      await capture.start();
      this.microphoneCapture = capture;
    } catch (error) {
      await capture.close().catch(() => {});
      throw error;
    }
  }

  async stopMicrophone(): Promise<SttMicrophoneRecording> {
    if (!this.microphoneCapture?.isRecording) {
      throw new Error("STT microphone recording is not active.");
    }

    const capture = this.microphoneCapture;
    this.microphoneCapture = null;
    const recorded = await capture.stop();

    return {
      audio: recorded.samples,
      sampleRate: recorded.sampleRate,
      durationMs: Math.round(recorded.durationSec * 1000),
    };
  }

  async createSession(): Promise<SttSession> {
    if (!this.supportsStreaming) {
      throw new Error(
        `Model ${this.modelId} does not support streaming sessions. Load a streaming-capable STT model first.`,
      );
    }

    const sessionId = await SttWorkerBridge.createSession();
    return new SttSession(this.modelId, sessionId);
  }
}

export async function loadSttModel(
  modelId: string,
  options: LoadSttModelOptions = {},
): Promise<SttModel> {
  return SttModel.load(modelId, options);
}

export class SttSession {
  private microphoneCapture: MicrophoneCapture | null = null;
  private microphoneQueue: Promise<void> = Promise.resolve();
  private microphoneChunkCount = 0;

  constructor(
    public readonly modelId: string,
    private readonly sessionId: number,
  ) {}

  async push(options: StreamingTranscribeChunk): Promise<void> {
    await SttWorkerBridge.pushSessionAudio({
      sessionId: this.sessionId,
      samples: options.audio,
      sampleRate: options.sampleRate ?? TARGET_SAMPLE_RATE,
    });
  }

  async startMicrophone(options: SttMicrophoneOptions = {}): Promise<void> {
    if (this.microphoneCapture?.isRecording) {
      return;
    }

    const capture = await createMicrophoneCapture({
      sampleRate: normalizeSampleRate(options.sampleRate),
    });

    this.microphoneQueue = Promise.resolve();
    this.microphoneChunkCount = 0;

    try {
      await capture.start({
        onChunk: (samples, sampleRate) => {
          this.microphoneChunkCount += 1;
          this.microphoneQueue = this.microphoneQueue.then(async () => {
            await this.push({ audio: samples, sampleRate });
            const result = await this.getResult();
            await options.onResult?.(result);
          });
        },
      });
      this.microphoneCapture = capture;
    } catch (error) {
      await capture.close().catch(() => {});
      throw error;
    }
  }

  async stopMicrophone(): Promise<SttMicrophoneCaptureResult> {
    if (!this.microphoneCapture?.isRecording) {
      throw new Error("Streaming STT microphone capture is not active.");
    }

    const capture = this.microphoneCapture;
    this.microphoneCapture = null;
    const recorded = await capture.stop();
    await this.microphoneQueue;

    return {
      durationMs: Math.round(recorded.durationSec * 1000),
      sampleRate: recorded.sampleRate,
      chunkCount: this.microphoneChunkCount,
    };
  }

  async getResult(): Promise<StreamingTranscriptionResult> {
    return SttWorkerBridge.getSessionResult(this.sessionId);
  }

  async finish(): Promise<StreamingTranscriptionResult> {
    return SttWorkerBridge.finishSession(this.sessionId);
  }

  async reset(): Promise<void> {
    await SttWorkerBridge.resetSession(this.sessionId);
  }

  async close(): Promise<void> {
    if (this.microphoneCapture) {
      await this.microphoneCapture.close().catch(() => {});
      this.microphoneCapture = null;
    }
    await SttWorkerBridge.closeSession(this.sessionId);
  }
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  return typeof sampleRate === "number" && Number.isFinite(sampleRate)
    ? Math.max(1, Math.trunc(sampleRate))
    : TARGET_SAMPLE_RATE;
}

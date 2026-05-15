import { getPersistentId, setPersistentId } from "../util/persistentIdStorage.js";
import { SttWorkerBridge } from "../worker/sttWorkerBridge.js";
import type {
  DecodedAudio,
  LoadSttModelOptions,
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
  private constructor(
    public readonly modelId: string,
    public readonly family: string,
    public readonly supportsStreaming: boolean,
  ) {}

  static async load(modelId: string, options: LoadSttModelOptions = {}): Promise<SttModel> {
    const cachedPersistentId = getPersistentId();
    const response = await SttWorkerBridge.loadModel(
      {
        modelId,
        modelAssetHost: options.modelAssetHost,
        language: options.language,
        task: options.task,
      },
      cachedPersistentId ?? undefined,
      (message) => {
        options.onProgress?.(message.event);
      },
    );

    setPersistentId(response.persistentId);
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
    await SttWorkerBridge.closeSession(this.sessionId);
  }
}

import Wfloat, {
  type NativeLoadModelProgressEvent,
  type NativeStreamingTranscriptionResult,
  type NativeTranscriptionResult,
} from '../NativeWfloat';
import { getSttModelAssets } from '../modelAssets';
import type {
  LoadSttModelOptions,
  SttMicrophoneCaptureResult,
  SttMicrophoneOptions,
  SttMicrophoneRecording,
  SttMicrophoneRecordingOptions,
  StreamingTranscribeChunk,
  StreamingTranscriptionResult,
  TranscribeOptions,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionToken,
} from './types';

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_STREAMING_CHUNK_MS = 250;

function normalizeLoadProgressEvent(
  event: NativeLoadModelProgressEvent
): import('../tts/types').LoadModelProgressEvent | null {
  if (event.status === 'downloading') {
    return {
      status: 'downloading',
      progress:
        typeof event.progress === 'number' && Number.isFinite(event.progress)
          ? Math.min(Math.max(event.progress, 0), 1)
          : 0,
    };
  }

  if (event.status === 'loading') {
    return { status: 'loading' };
  }

  if (event.status === 'completed') {
    return { status: 'completed' };
  }

  console.warn(`Ignoring unknown loadModel progress event status "${event.status}".`);
  return null;
}

function normalizeAudioSamples(audio: ReadonlyArray<number> | Float32Array): number[] {
  if (audio instanceof Float32Array) {
    return Array.from(audio);
  }

  return Array.from(audio, (value) => Number(value));
}

function mapToken(token: NativeTranscriptionResult['tokens'][number]): TranscriptionToken {
  return {
    text: typeof token.text === 'string' ? token.text : '',
    startSec:
      typeof token.startSec === 'number' && Number.isFinite(token.startSec)
        ? token.startSec
        : 0,
    durationSec:
      typeof token.durationSec === 'number' && Number.isFinite(token.durationSec)
        ? token.durationSec
        : 0,
    confidence:
      typeof token.confidence === 'number' && Number.isFinite(token.confidence)
        ? token.confidence
        : 0,
  };
}

function mapSegment(
  segment: NativeTranscriptionResult['segments'][number]
): TranscriptionSegment {
  return {
    text: typeof segment.text === 'string' ? segment.text : '',
    startSec:
      typeof segment.startSec === 'number' && Number.isFinite(segment.startSec)
        ? segment.startSec
        : 0,
    durationSec:
      typeof segment.durationSec === 'number' && Number.isFinite(segment.durationSec)
        ? segment.durationSec
        : 0,
  };
}

function mapTranscriptionResult(result: NativeTranscriptionResult): TranscriptionResult {
  return {
    text: typeof result.text === 'string' ? result.text : '',
    modelId: typeof result.modelId === 'string' ? result.modelId : '',
    language: typeof result.language === 'string' ? result.language : '',
    emotion: typeof result.emotion === 'string' ? result.emotion : '',
    event: typeof result.event === 'string' ? result.event : '',
    json: typeof result.json === 'string' ? result.json : '',
    tokens: Array.isArray(result.tokens) ? result.tokens.map(mapToken) : undefined,
    segments: Array.isArray(result.segments)
      ? result.segments.map(mapSegment)
      : undefined,
  };
}

function mapStreamingResult(
  result: NativeStreamingTranscriptionResult
): StreamingTranscriptionResult {
  return {
    text: typeof result.text === 'string' ? result.text : '',
    modelId: typeof result.modelId === 'string' ? result.modelId : '',
    isEndpoint: Boolean(result.isEndpoint),
    json: typeof result.json === 'string' ? result.json : '',
  };
}

export class SttSession {
  private microphoneResultPoll: ReturnType<typeof globalThis.setInterval> | null = null;
  private microphoneResultPollGeneration = 0;

  constructor(
    public readonly modelId: string,
    private readonly sessionId: number
  ) {}

  async push(options: StreamingTranscribeChunk): Promise<void> {
    await Wfloat.pushSttSessionAudio({
      sessionId: this.sessionId,
      samples: normalizeAudioSamples(options.audio),
      sampleRate:
        typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
          ? Math.max(1, Math.trunc(options.sampleRate))
          : TARGET_SAMPLE_RATE,
    });
  }

  async startMicrophone(options: SttMicrophoneOptions = {}): Promise<void> {
    this.stopMicrophoneResultPolling();

    const sampleRate =
      typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
        ? Math.max(1, Math.trunc(options.sampleRate))
        : TARGET_SAMPLE_RATE;
    const chunkMs =
      typeof options.chunkMs === 'number' && Number.isFinite(options.chunkMs)
        ? Math.max(100, Math.trunc(options.chunkMs))
        : DEFAULT_STREAMING_CHUNK_MS;

    await Wfloat.startSttSessionMicrophone({
      sessionId: this.sessionId,
      sampleRate,
      chunkMs,
    });

    if (options.onResult) {
      this.startMicrophoneResultPolling(chunkMs, options.onResult);
    }
  }

  async stopMicrophone(): Promise<SttMicrophoneCaptureResult> {
    this.stopMicrophoneResultPolling();
    return Wfloat.stopSttSessionMicrophone({ sessionId: this.sessionId });
  }

  async getResult(): Promise<StreamingTranscriptionResult> {
    return mapStreamingResult(
      await Wfloat.getSttSessionResult({ sessionId: this.sessionId })
    );
  }

  async finish(): Promise<StreamingTranscriptionResult> {
    return mapStreamingResult(
      await Wfloat.finishSttSession({ sessionId: this.sessionId })
    );
  }

  async reset(): Promise<void> {
    await Wfloat.resetSttSession({ sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    this.stopMicrophoneResultPolling();
    await Wfloat.closeSttSession({ sessionId: this.sessionId });
  }

  private startMicrophoneResultPolling(
    intervalMs: number,
    onResult: (result: StreamingTranscriptionResult) => void | Promise<void>
  ): void {
    const generation = this.microphoneResultPollGeneration;
    let inFlight = false;

    this.microphoneResultPoll = globalThis.setInterval(() => {
      if (inFlight || generation !== this.microphoneResultPollGeneration) {
        return;
      }

      inFlight = true;
      this.getResult()
        .then(async (result) => {
          if (generation === this.microphoneResultPollGeneration) {
            await onResult(result);
          }
        })
        .catch((error: unknown) => {
          console.warn(
            error instanceof Error
              ? error.message
              : 'Failed to read streaming STT microphone result.'
          );
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
  }

  private stopMicrophoneResultPolling(): void {
    this.microphoneResultPollGeneration += 1;
    if (this.microphoneResultPoll) {
      globalThis.clearInterval(this.microphoneResultPoll);
      this.microphoneResultPoll = null;
    }
  }
}

export class SttModel {
  private constructor(
    public readonly modelId: string,
    public readonly family: string,
    public readonly supportsStreaming: boolean
  ) {}

  static async load(
    modelId: string,
    options: LoadSttModelOptions = {}
  ): Promise<SttModel> {
    const modelAssets = await getSttModelAssets(modelId, options.modelAssetHost);
    const progressSubscription = Wfloat.onLoadModelProgress(
      (event: NativeLoadModelProgressEvent) => {
        const normalized = normalizeLoadProgressEvent(event);
        if (normalized) {
          options.onProgress?.(normalized);
        }
      }
    );

    try {
      const nativeResult = await Wfloat.loadSttModel({
        modelId,
        family: modelAssets.family,
        modelUrl: modelAssets.model ?? '',
        tokensUrl: modelAssets.tokens ?? '',
        preprocessorUrl: modelAssets.preprocessor ?? '',
        encoderUrl: modelAssets.encoder ?? '',
        decoderUrl: modelAssets.decoder ?? '',
        joinerUrl: modelAssets.joiner ?? '',
        uncachedDecoderUrl: modelAssets.uncached_decoder ?? '',
        cachedDecoderUrl: modelAssets.cached_decoder ?? '',
        language: options.language ?? '',
        task: options.task ?? '',
      });
      options.onProgress?.({ status: 'completed' });
      const model = new SttModel(
        modelId,
        nativeResult.family,
        nativeResult.supportsStreaming
      );
      return model;
    } finally {
      progressSubscription.remove();
    }
  }

  async transcribe(options: TranscribeOptions): Promise<TranscriptionResult> {
    return mapTranscriptionResult(
      await Wfloat.transcribe({
        samples: normalizeAudioSamples(options.audio),
        sampleRate: Math.max(1, Math.trunc(options.sampleRate)),
        language: '',
        task: '',
        hotwords: '',
      })
    );
  }

  async startMicrophone(options: SttMicrophoneRecordingOptions = {}): Promise<void> {
    const sampleRate =
      typeof options.sampleRate === 'number' && Number.isFinite(options.sampleRate)
        ? Math.max(1, Math.trunc(options.sampleRate))
        : TARGET_SAMPLE_RATE;

    await Wfloat.startSttMicrophoneRecording({ sampleRate });
  }

  async stopMicrophone(): Promise<SttMicrophoneRecording> {
    const recording = await Wfloat.stopSttMicrophoneRecording();
    return {
      audio: Float32Array.from(recording.samples),
      sampleRate: Math.max(1, Math.trunc(recording.sampleRate)),
      durationMs:
        typeof recording.durationMs === 'number' && Number.isFinite(recording.durationMs)
          ? Math.max(0, Math.trunc(recording.durationMs))
          : 0,
    };
  }

  async createSession(): Promise<SttSession> {
    if (!this.supportsStreaming) {
      throw new Error(
        `Model ${this.modelId} does not support streaming sessions. Load a streaming-capable STT model first.`
      );
    }

    const sessionId = await Wfloat.createSttSession();
    return new SttSession(this.modelId, sessionId);
  }
}

export async function loadSttModel(
  modelId: string,
  options: LoadSttModelOptions = {}
): Promise<SttModel> {
  return SttModel.load(modelId, options);
}

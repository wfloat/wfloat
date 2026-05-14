export type Capability =
  | "tts"
  | "stt"
  | "vad"
  | "llm"
  | "embedding"
  | "vlm"
  | "diarization"
  | "speaker"
  | "wakeword";

export type Backend = "sherpa-onnx" | "llama.cpp" | "unknown";

export type ModelFamily =
  | "wfloat-expressive-tts"
  | "piper"
  | "kokoro"
  | "whisper"
  | "moonshine"
  | "parakeet-ctc"
  | "parakeet-tdt"
  | "silero-vad"
  | "qwen"
  | "llama"
  | "mistral"
  | "phi"
  | "gemma"
  | "lfm2"
  | "youtu"
  | "smollm"
  | "vlm"
  | "unknown";

export type ProgressEvent =
  | {
      status: "downloading";
      progress: number;
    }
  | {
      status: "validating";
    }
  | {
      status: "loading";
    }
  | {
      status: "completed";
    };

export interface ModelFeatures {
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsStructuredOutput?: boolean;
  supportsDialogue?: boolean;
  supportsEmotion?: boolean;
  supportsSpeakerSelection?: boolean;
  supportsLexicon?: boolean;
  supportsTimeline?: boolean;
  supportsPhonemeConversion?: boolean;
  supportsReferenceAudio?: boolean;
  supportsImages?: boolean;
  supportsAudioInput?: boolean;
  supportsBatchEmbedding?: boolean;
}

export interface ModelInfo {
  id: string;
  capability: Capability;
  backend: Backend;
  family: ModelFamily;
  features: ModelFeatures;
}

export interface LoadOptions {
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface PreparedModel extends ModelInfo {
  unload(): Promise<void>;
}

export interface AudioResult {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

export interface TimelineChunk {
  index: number;
  text: string;
  highlightStart: number;
  highlightEnd: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  progress: number;
  voice?: string | number;
  sid?: number;
  segmentIndex?: number;
}

export interface Timeline {
  chunks: TimelineChunk[];
  durationSec: number;
}

export type TtsProgressStage = "preparing" | "generating" | "completed";

export interface TtsProgressEvent {
  stage: TtsProgressStage;
  progress: number;
  chunkIndex?: number;
  chunkCount?: number;
  text?: string;
  highlightStart?: number;
  highlightEnd?: number;
}

export interface TtsSynthesisResult {
  audio: AudioResult;
  timeline: Timeline;
  modelId: string;
  text: string;
}

export interface TtsSynthesizeOptions {
  text: string;
  voice?: string | number;
  speed?: number;
  onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsDialogueSegment {
  text: string;
  voice?: string | number;
  speed?: number;
}

export interface TtsDialogueOptions {
  segments: TtsDialogueSegment[];
  onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsModel extends PreparedModel {
  capability: "tts";
  sampleRate: number;
  numSpeakers: number;
  synthesize(options: TtsSynthesizeOptions): Promise<TtsSynthesisResult>;
  synthesizeDialogue(options: TtsDialogueOptions): Promise<TtsSynthesisResult>;
}

export interface SttTranscriptionResult {
  text: string;
}

export interface SttModel extends PreparedModel {
  capability: "stt";
  transcribe(options: { audio: Float32Array; language?: string }): Promise<SttTranscriptionResult>;
  createSession?(): Promise<SttSession>;
}

export interface SttSession {
  push(audio: Float32Array): Promise<void>;
  finish(): Promise<SttTranscriptionResult>;
  cancel(): Promise<void>;
}

export interface VadModel extends PreparedModel {
  capability: "vad";
  detect(options: { audio: Float32Array }): Promise<{ hasSpeech: boolean }>;
  createSession(): Promise<VadSession>;
}

export interface VadSession {
  push(audio: Float32Array): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface LlmModel extends PreparedModel {
  capability: "llm";
  generate(options: {
    prompt?: string;
    messages?: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string }>;
  stream?(
    options: {
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<string>;
}

export interface EmbeddingModel extends PreparedModel {
  capability: "embedding";
  embed(options: { text: string | string[] }): Promise<{ vectors: number[][] }>;
}

export interface VlmModel extends PreparedModel {
  capability: "vlm";
  generate(options: {
    prompt?: string;
    messages?: Array<{ role: string; content: string }>;
    images: Array<
      | { format: "rgb"; rgbPixels: Uint8Array; width: number; height: number }
      | { format: "base64"; data: string }
      | { format: "file-path"; path: string }
    >;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string }>;
  stream?(
    options: {
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
      images: Array<
        | { format: "rgb"; rgbPixels: Uint8Array; width: number; height: number }
        | { format: "base64"; data: string }
        | { format: "file-path"; path: string }
      >;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    },
  ): AsyncIterable<string>;
}

export interface ModelRegistry {
  list(): Promise<ModelInfo[]>;
  get(modelId: string): Promise<ModelInfo | null>;
  prepare(modelId: string, options?: LoadOptions): Promise<ModelInfo>;
}

export interface TtsNamespace {
  load(modelId: string, options?: LoadOptions): Promise<TtsModel>;
}

export interface SttNamespace {
  load(modelId: string, options?: LoadOptions): Promise<SttModel>;
}

export interface VadNamespace {
  load(modelId: string, options?: LoadOptions): Promise<VadModel>;
}

export interface LlmNamespace {
  load(modelId: string, options?: LoadOptions): Promise<LlmModel>;
}

export interface EmbeddingsNamespace {
  load(modelId: string, options?: LoadOptions): Promise<EmbeddingModel>;
}

export interface VlmNamespace {
  load(modelId: string, options?: LoadOptions): Promise<VlmModel>;
}

export interface WfloatPublicApi {
  models: ModelRegistry;
  tts: TtsNamespace;
  stt: SttNamespace;
  vad: VadNamespace;
  llm: LlmNamespace;
  embeddings: EmbeddingsNamespace;
  vlm: VlmNamespace;
}

// Deferred on purpose:
// The current Wfloat expressive TTS path has additional behavior around
// emotion/dialogue/playback scheduling that should be revisited after
// wfloat-core exists. Do not freeze that public surface here yet.

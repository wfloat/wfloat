export { TtsModel, loadTtsModel } from "./tts/model.js";
export { SttModel, SttSession, loadSttModel } from "./stt/model.js";
export { VadModel, VadSession, loadVadModel } from "./vad/model.js";
export { LlmModel, loadLlmModel } from "./llm/model.js";
export {
  createMicrophoneCapture,
  type CapturedMicrophoneAudio,
  type MicrophoneCapture,
  type MicrophoneCaptureOptions,
} from "./audio/index.js";
export type {
  AudioResult,
  LoadModelProgressEvent,
  LoadTtsModelOptions,
  Timeline,
  TimelineChunk,
  TtsDialogueOptions,
  TtsDialogueSegment,
  TtsEmotion,
  TtsProgressEvent,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from "./tts/types.js";
export type {
  DecodedAudio,
  LoadSttModelOptions,
  SttMicrophoneCaptureResult,
  SttMicrophoneOptions,
  SttMicrophoneRecording,
  SttMicrophoneRecordingOptions,
  StreamingTranscribeChunk,
  StreamingTranscriptionResult,
  TranscribeOptions as LegacyTranscribeOptions,
  TranscriptionResult as LegacyTranscriptionResult,
  TranscriptionSegment,
  TranscriptionToken,
} from "./stt/types.js";
export type {
  DecodedVadAudio,
  LoadVadModelOptions,
  VadDetectOptions,
  VadDetectionResult,
  VadMicrophoneCaptureResult,
  VadMicrophoneOptions,
  VadSegment,
  VadSessionOptions,
  VadSpeechStartEvent,
} from "./vad/types.js";
export type {
  LlmChatMessage,
  LlmChatTemplateFormat,
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmTokenEvent,
  LoadLlmModelOptions,
} from "./llm/types.js";
export { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from "./tts/catalog.js";

// Current model-instance surfaces. Legacy exports above remain available during migration.
import './runtime/urls.js';
export { LanguageModel } from './llm-next/model.js';
export { loadLanguageModel } from './llm-next/load.js';
export type { LoadLanguageModelOptions } from './llm-next/load.js';
export { defineTool } from './llm-next/tools.js';
export { GenerationError, toolResult } from './llm-next/util.js';
export type {
  JsonValue, Message, AssistantPart, ToolMessage, ToolCall, ToolDefinition,
  ToolExecutionContext, GenerationOptions, GenerationResult, GenerationRound,
  PartialGenerationResult, LanguageGeneration, StopReason, ContextLimit,
  SamplingOptions, ToolEvent, ToolGenerationOptions, ToolCallFor,
} from './llm-next/types.js';
export { downloadModel, deleteModelAssets, ModelAssetsDeletedError, AssetStorageError, AssetIntegrityError } from './assets/index.js';
export type { DownloadModelOptions, ModelProgressEvent } from './assets/types.js';
export type { SchemaInput, JSONSchema, InferSchema, InferSchemaInput } from './schema/types.js';
export { SchemaConfigurationError } from './schema/adapter.js';
export { loadTextToSpeech, TextToSpeechModel } from './tts-next/index.js';
export type {
  LoadTextToSpeechOptions, SpeechHighlight, SpeechTiming, SpeechAudio, SpeechChunk,
  SpeechResult, PlaybackEvent, PlaybackOptions, SynthesisOptions, SpeechSegment,
  GenerateOptions, SpeakOptions, SpeechHandle, SpeechGeneration,
} from './tts-next/index.js';

// Complete-audio and live-input transcription use distinct task surfaces.
export { loadSpeechToText, loadStreamingSpeechToText } from './stt-next/load.js';
export { SpeechToTextModel, StreamingSpeechToTextModel } from './stt-next/model.js';
export { TranscriptionError } from './stt-next/types.js';
export type {
  LoadSpeechToTextOptions, PcmAudio, TranscriptionAudio, RecognitionOptions,
  TranscribeOptions, TranscriptionSessionOptions, Transcription, TranscriptionSession,
  TranscriptionResult, LiveTranscriptionResult, TranscriptData, LiveTranscriptData,
  TranscriptTiming, TranscriptWord, TranscriptSegment, LiveTranscriptSegment,
  PartialTranscript, LivePartialTranscript, ProvisionalTranscript,
  TranscriptionUpdate, LiveTranscriptUpdate,
} from './stt-next/types.js';

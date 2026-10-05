export { TtsModel, loadTtsModel } from './tts/model';
export { SttModel, SttSession, loadSttModel } from './stt/model';
export { VadModel, VadSession as LegacyVadSession, loadVadModel } from './vad/model';
export { LlmModel, loadLlmModel } from './llm/model';
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
} from './tts/types';
export type {
  LoadSttModelOptions,
  SttMicrophoneCaptureResult,
  SttMicrophoneOptions,
  SttMicrophoneRecording,
  SttMicrophoneRecordingOptions,
  StreamingTranscriptionResult,
  StreamingTranscribeChunk,
  TranscribeOptions as LegacyTranscribeOptions,
  TranscriptionResult as LegacyTranscriptionResult,
  TranscriptionSegment,
  TranscriptionToken,
} from './stt/types';
export type {
  LoadVadModelOptions,
  VadDetectOptions,
  VadDetectionResult,
  VadMicrophoneCaptureResult,
  VadMicrophoneOptions,
  VadSegment,
  VadSessionOptions as LegacyVadSessionOptions,
  VadSpeechStartEvent as LegacyVadSpeechStartEvent,
} from './vad/types';
export type {
  LlmChatMessage,
  LlmChatOptions,
  LlmChatRole,
  LlmGenerateOptions,
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmTokenEvent,
  LoadLlmModelOptions,
} from './llm/types';
export { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from './tts/catalog';

// Current model-instance surfaces. Legacy exports above remain available during migration.
export { LanguageModel } from './next/llm-next/model';
export { loadLanguageModel } from './next/llm-next/load';
export type { LoadLanguageModelOptions } from './next/llm-next/load';
export { defineTool } from './next/llm-next/tools';
export { GenerationError, toolResult } from './next/llm-next/util';
export type {
  JsonValue, Message, AssistantPart, ToolMessage, ToolCall, ToolDefinition,
  ToolExecutionContext, GenerationOptions, GenerationResult, GenerationRound,
  PartialGenerationResult, LanguageGeneration, StopReason, ContextLimit,
  SamplingOptions, ToolEvent, ToolGenerationOptions, ToolCallFor,
} from './next/llm-next/types';
export { downloadModel, deleteModelAssets, ModelAssetsDeletedError, AssetStorageError, AssetIntegrityError } from './next/assets/index';
export type { DownloadModelOptions, ModelProgressEvent } from './next/assets/types';
export type { SchemaInput, JSONSchema, InferSchema, InferSchemaInput } from './next/schema/types';
export { SchemaConfigurationError } from './next/schema/adapter';
export { loadTextToSpeech, TextToSpeechModel } from './next/tts-next/index';
export type {
  LoadTextToSpeechOptions, SpeechHighlight, SpeechTiming, SpeechAudio, SpeechChunk,
  SpeechResult, PlaybackEvent, PlaybackOptions, SynthesisOptions, SpeechSegment,
  GenerateOptions, SpeakOptions, SpeechHandle, SpeechGeneration,
} from './next/tts-next/index';

// Complete-audio and live-input transcription use distinct task surfaces.
export { loadSpeechToText, loadStreamingSpeechToText } from './next/stt-next/load';
export { SpeechToTextModel, StreamingSpeechToTextModel } from './next/stt-next/model';
export { TranscriptionError } from './next/stt-next/types';
export type {
  LoadSpeechToTextOptions, PcmAudio, TranscriptionAudio, RecognitionOptions,
  TranscribeOptions, TranscriptionSessionOptions, Transcription, TranscriptionSession,
  TranscriptionResult, LiveTranscriptionResult, TranscriptData, LiveTranscriptData,
  TranscriptTiming, TranscriptWord, TranscriptSegment, LiveTranscriptSegment,
  PartialTranscript, LivePartialTranscript, ProvisionalTranscript,
  TranscriptionUpdate, LiveTranscriptUpdate,
} from './next/stt-next/types';

export { createMicrophoneCapture } from './next/audio-next/microphone';
export type { MicrophoneCapture, MicrophoneOptions, CaptureState, BackgroundBehavior } from './next/audio-next/microphone';
export { loadVoiceActivityDetection } from './next/vad-next/load';
export { VoiceActivityDetectionModel } from './next/vad-next/model';
export { VadError } from './next/vad-next/types';
export type {
  LoadVoiceActivityDetectionOptions, VadAudioInput, VadSpeechRange,
  VadSpeechStartEvent, VadSpeechSegment, VadProbabilityEvent, VadOptions,
  VadSessionOptions, VadSession, VadSessionData, VadSessionResult,
  Detection, DetectionData, DetectionResult,
} from './next/vad-next/types';

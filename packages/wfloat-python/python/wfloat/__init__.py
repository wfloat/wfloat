from ._constants import SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS
from ._llm import LlmModel
from ._llm_load import load_llm_model
from ._model import Model, TtsModel, load, load_tts_model
from ._stt import SttModel, SttSession
from ._stt_load import load_moonshine_tiny_en, load_stt_model, load_whisper_tiny_en
from ._vad import VadModel
from ._vad_load import load_silero_vad, load_vad_model
from ._results import (
    Audio,
    AudioResult,
    GenerationResult,
    LlmGenerationResult,
    StreamingTranscriptionResult,
    TranscriptionResult,
    TranscriptionSegment,
    TranscriptionToken,
    Timeline,
    TimelineChunk,
    TtsSynthesisResult,
    VadDetectionResult,
    VadSegment,
)
from ._version import __version__

__all__ = [
    "Audio",
    "AudioResult",
    "GenerationResult",
    "LlmGenerationResult",
    "LlmModel",
    "Model",
    "SPEAKER_IDS",
    "SttModel",
    "SttSession",
    "StreamingTranscriptionResult",
    "TtsModel",
    "Timeline",
    "TimelineChunk",
    "TranscriptionResult",
    "TranscriptionSegment",
    "TranscriptionToken",
    "TtsSynthesisResult",
    "VALID_EMOTIONS",
    "VALID_SIDS",
    "VadDetectionResult",
    "VadModel",
    "VadSegment",
    "load",
    "load_llm_model",
    "load_moonshine_tiny_en",
    "load_silero_vad",
    "load_stt_model",
    "load_whisper_tiny_en",
    "load_tts_model",
    "load_vad_model",
]

# Redesigned synchronous surface. Legacy loaders above remain importable, while
# the value types below describe the new task-specific loaders.
from ._audio import Audio
from ._operations import OperationCancelledError
from ._schemas import SchemaConfigurationError, SchemaValidationError
from ._tools import ToolContext, ToolDefinition, define_tool
from ._language_types import (
    GenerationResult, GenerationError, GenerationRound, PartialGenerationResult,
    Usage, ContextLimit, StructuredOutput, StopContext, ToolCall,
    TextEvent, ReasoningEvent, RoundStartEvent, ToolCallEvent, ToolStartEvent,
    ToolResultEvent, ToolErrorEvent, ToolCancelEvent, ToolValidationErrorEvent,
    GenerationEvent, StopReason, ToolValidationError,
)
from ._language import LanguageModel, LanguageStream, tool_result
from ._language_load import load_language_model
from ._speech import (
    TextToSpeechModel, SpeechResult, SpeechChunk, SpeechTiming, SpeechSegment,
    SpeechStream, load_text_to_speech,
)
from ._recognition import (
    SpeechToTextModel, StreamingSpeechToTextModel, TranscriptionSession,
    TranscriptionResult, TranscriptionUpdate, LiveTranscriptUpdate,
    TranscriptTiming, TranscriptWord, TranscriptSegment, ProvisionalTranscript,
    PartialTranscript, TranscriptionError, load_speech_to_text,
    load_streaming_speech_to_text,
)
from ._activity import (
    VoiceActivityDetectionModel, VadSession, DetectionResult, VadSessionResult,
    SpeechRange, SpeechStartEvent, VadProbabilityEvent, VadError,
    load_voice_activity_detection,
)
from ._lifecycle import (
    download_model, delete_model_assets, ModelProgressEvent,
    ModelAssetsDeletedError, ModelAssetsInUseError,
)

__all__ += [
    "OperationCancelledError", "SchemaConfigurationError", "SchemaValidationError",
    "ToolContext", "ToolDefinition", "define_tool", "tool_result", "ToolCall",
    "LanguageModel", "LanguageStream", "GenerationError", "GenerationRound",
    "PartialGenerationResult", "Usage", "ContextLimit", "StructuredOutput", "StopContext",
    "GenerationEvent", "StopReason", "ToolValidationError",
    "TextEvent", "ReasoningEvent", "RoundStartEvent", "ToolCallEvent", "ToolStartEvent",
    "ToolResultEvent", "ToolErrorEvent", "ToolCancelEvent", "ToolValidationErrorEvent",
    "TextToSpeechModel", "SpeechResult", "SpeechChunk", "SpeechTiming", "SpeechSegment",
    "SpeechStream", "SpeechToTextModel", "StreamingSpeechToTextModel", "TranscriptionSession",
    "TranscriptionUpdate", "LiveTranscriptUpdate", "TranscriptTiming", "TranscriptWord",
    "TranscriptSegment", "ProvisionalTranscript", "PartialTranscript", "TranscriptionError",
    "VoiceActivityDetectionModel", "VadSession", "DetectionResult", "VadSessionResult",
    "SpeechRange", "SpeechStartEvent", "VadProbabilityEvent", "VadError",
    "load_language_model", "load_text_to_speech", "load_speech_to_text",
    "load_streaming_speech_to_text", "load_voice_activity_detection",
    "download_model", "delete_model_assets", "ModelProgressEvent",
    "ModelAssetsDeletedError", "ModelAssetsInUseError",
]

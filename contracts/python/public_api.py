from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal, Optional, Protocol, Sequence


Capability = Literal[
    "tts",
    "stt",
    "vad",
    "llm",
    "embedding",
    "vlm",
    "diarization",
    "speaker",
    "wakeword",
]

Backend = Literal["sherpa-onnx", "llama.cpp", "unknown"]

ModelFamily = Literal[
    "wfloat-expressive-tts",
    "piper",
    "kokoro",
    "whisper",
    "moonshine",
    "parakeet-ctc",
    "parakeet-tdt",
    "silero-vad",
    "qwen",
    "llama",
    "mistral",
    "phi",
    "gemma",
    "lfm2",
    "youtu",
    "smollm",
    "vlm",
    "unknown",
]


@dataclass
class ModelFeatures:
    supports_streaming: bool = False
    supports_tools: bool = False
    supports_thinking: bool = False
    supports_structured_output: bool = False
    supports_dialogue: bool = False
    supports_emotion: bool = False
    supports_speaker_selection: bool = False
    supports_lexicon: bool = False
    supports_timeline: bool = False
    supports_phoneme_conversion: bool = False
    supports_reference_audio: bool = False
    supports_images: bool = False
    supports_audio_input: bool = False
    supports_batch_embedding: bool = False


@dataclass
class ModelInfo:
    id: str
    capability: Capability
    backend: Backend
    family: ModelFamily
    features: ModelFeatures


class PreparedModel(Protocol):
    id: str
    capability: Capability
    backend: Backend
    family: ModelFamily
    features: ModelFeatures

    def unload(self) -> None: ...


@dataclass
class AudioResult:
    samples: list[float]
    sample_rate: int
    duration_sec: float


@dataclass
class TimelineChunk:
    index: int
    text: str
    highlight_start: int
    highlight_end: int
    start_sec: float
    end_sec: float
    duration_sec: float
    progress: float
    voice: Optional[str | int] = None
    sid: Optional[int] = None
    segment_index: Optional[int] = None


@dataclass
class Timeline:
    chunks: list[TimelineChunk]
    duration_sec: float


@dataclass
class TtsProgressEvent:
    stage: Literal["preparing", "generating", "completed"]
    progress: float
    chunk_index: Optional[int] = None
    chunk_count: Optional[int] = None
    text: Optional[str] = None
    highlight_start: Optional[int] = None
    highlight_end: Optional[int] = None


@dataclass
class TtsSynthesisResult:
    audio: AudioResult
    timeline: Timeline
    model_id: str
    text: str


@dataclass
class TtsDialogueSegment:
    text: str
    voice: Optional[str | int] = None
    speed: Optional[float] = None


class TtsModel(PreparedModel, Protocol):
    capability: Literal["tts"]
    sample_rate: int
    num_speakers: int

    def synthesize(
        self,
        *,
        text: str,
        voice: Optional[str | int] = None,
        speed: Optional[float] = None,
        on_progress: Optional[Callable[[TtsProgressEvent], None]] = None,
    ) -> TtsSynthesisResult: ...

    def synthesize_dialogue(
        self,
        *,
        segments: Sequence[TtsDialogueSegment],
        on_progress: Optional[Callable[[TtsProgressEvent], None]] = None,
    ) -> TtsSynthesisResult: ...


class SttSession(Protocol):
    def push(self, audio: bytes | Sequence[float]) -> None: ...
    def finish(self) -> str: ...
    def cancel(self) -> None: ...


class SttModel(PreparedModel, Protocol):
    capability: Literal["stt"]

    def transcribe(
        self,
        *,
        audio: bytes | Sequence[float],
        language: Optional[str] = None,
    ) -> str: ...

    def create_session(self) -> SttSession: ...


class VadSession(Protocol):
    def push(self, audio: bytes | Sequence[float]) -> None: ...
    def reset(self) -> None: ...
    def close(self) -> None: ...


class VadModel(PreparedModel, Protocol):
    capability: Literal["vad"]

    def detect(self, *, audio: bytes | Sequence[float]) -> bool: ...
    def create_session(self) -> VadSession: ...


class LlmModel(PreparedModel, Protocol):
    capability: Literal["llm"]

    def generate(
        self,
        *,
        prompt: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> str: ...


class EmbeddingModel(PreparedModel, Protocol):
    capability: Literal["embedding"]

    def embed(self, *, text: str | Sequence[str]) -> list[list[float]]: ...


class VlmModel(PreparedModel, Protocol):
    capability: Literal["vlm"]

    def generate(
        self,
        *,
        prompt: Optional[str] = None,
        messages: Optional[list[dict[str, str]]] = None,
        images: Sequence[object],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> str: ...


class ModelRegistry(Protocol):
    def list(self) -> list[ModelInfo]: ...
    def get(self, model_id: str) -> Optional[ModelInfo]: ...
    def prepare(self, model_id: str) -> ModelInfo: ...


class TtsNamespace(Protocol):
    def load(self, model_id: str) -> TtsModel: ...


class SttNamespace(Protocol):
    def load(self, model_id: str) -> SttModel: ...


class VadNamespace(Protocol):
    def load(self, model_id: str) -> VadModel: ...


class LlmNamespace(Protocol):
    def load(self, model_id: str) -> LlmModel: ...


class EmbeddingsNamespace(Protocol):
    def load(self, model_id: str) -> EmbeddingModel: ...


class VlmNamespace(Protocol):
    def load(self, model_id: str) -> VlmModel: ...


class WfloatPublicApi(Protocol):
    models: ModelRegistry
    tts: TtsNamespace
    stt: SttNamespace
    vad: VadNamespace
    llm: LlmNamespace
    embeddings: EmbeddingsNamespace
    vlm: VlmNamespace


# Deferred on purpose:
# The current Wfloat expressive TTS path includes extra emotion/dialogue and
# playback-adjacent behavior that should be revisited after wfloat-core exists.

from ._constants import SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS
from ._model import Model, TtsModel, load, load_tts_model
from ._stt import SttModel, SttSession
from ._stt_load import load_moonshine_tiny_en, load_stt_model, load_whisper_tiny_en
from ._vad import VadModel
from ._vad_load import load_silero_vad, load_vad_model
from ._results import (
    Audio,
    AudioResult,
    GenerationResult,
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

_LOW_LEVEL_EXPORTS = {
    "GenerationConfig",
    "OfflineTts",
    "OfflineTtsConfig",
    "OfflineTtsModelConfig",
    "OfflineTtsWfloatModelConfig",
    "WfloatPreparedText",
    "git_date",
    "git_sha1",
    "prepare_wfloat_text",
    "version",
    "write_wave",
}


__all__ = [
    "Audio",
    "AudioResult",
    "GenerationResult",
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
    "load_moonshine_tiny_en",
    "load_silero_vad",
    "load_stt_model",
    "load_whisper_tiny_en",
    "load_tts_model",
    "load_vad_model",
]
__all__.extend(sorted(_LOW_LEVEL_EXPORTS))


def __getattr__(name):
    if name not in _LOW_LEVEL_EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    from . import _bindings

    value = getattr(_bindings, name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | _LOW_LEVEL_EXPORTS)

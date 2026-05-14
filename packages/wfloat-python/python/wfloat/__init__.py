from ._constants import SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS
from ._model import Model, TtsModel, load, load_tts_model
from ._results import (
    Audio,
    AudioResult,
    GenerationResult,
    Timeline,
    TimelineChunk,
    TtsSynthesisResult,
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
    "TtsModel",
    "Timeline",
    "TimelineChunk",
    "TtsSynthesisResult",
    "VALID_EMOTIONS",
    "VALID_SIDS",
    "load",
    "load_tts_model",
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

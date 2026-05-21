from pathlib import Path
from typing import Any

from ._constants import DEFAULT_NUM_THREADS, DEFAULT_PROVIDER
from ._core import create_core_tts

_BINDINGS_IMPORT_ERROR = None

try:
    from . import _bindings as bindings
except ImportError as exc:
    bindings = None
    _BINDINGS_IMPORT_ERROR = exc


def require_bindings() -> Any:
    if bindings is None:
        raise ImportError(
            "Failed to import sherpa_onnx. "
            "Reinstall wfloat so pip can install the matching wfloat-sherpa-onnx dependency."
        ) from _BINDINGS_IMPORT_ERROR
    return bindings


def create_native_tts(
    model_name: str,
    model_path: Path,
    tokens_path: Path,
    espeak_data_dir: Path,
):
    try:
        return create_core_tts(
            model_name=model_name,
            model_path=model_path,
            tokens_path=tokens_path,
            espeak_data_dir=espeak_data_dir,
        )
    except ImportError:
        pass
    except OSError:
        pass

    native_bindings = require_bindings()

    model_config = native_bindings.OfflineTtsWfloatModelConfig(
        model=str(model_path),
        tokens=str(tokens_path),
        data_dir=str(espeak_data_dir),
        noise_scale=0.667,
        noise_scale_w=0.8,
        length_scale=1.0,
    )

    tts_model_config = native_bindings.OfflineTtsModelConfig(
        wfloat=model_config,
        num_threads=DEFAULT_NUM_THREADS,
        debug=False,
        provider=DEFAULT_PROVIDER,
    )

    config = native_bindings.OfflineTtsConfig(
        model=tts_model_config,
        max_num_sentences=1,
    )

    return native_bindings.OfflineTts(config)


def create_native_vad(
    *,
    family: str,
    model_path: Path,
    threshold: float,
    min_silence_duration_sec: float,
    min_speech_duration_sec: float,
    max_speech_duration_sec: float,
    sample_rate: int,
    buffer_size_in_seconds: float,
):
    native_bindings = require_bindings()
    required_exports = (
        "SileroVadModelConfig",
        "TenVadModelConfig",
        "VadModelConfig",
        "VoiceActivityDetector",
    )
    missing_exports = [
        name for name in required_exports if not hasattr(native_bindings, name)
    ]
    if missing_exports:
        raise ImportError(
            "Installed sherpa_onnx is missing required VAD exports: "
            f"{', '.join(missing_exports)}. "
            "Reinstall wfloat so pip can install a compatible wfloat-sherpa-onnx build."
        )

    normalized_family = family.lower().replace("_", "-")
    if normalized_family in {"silero", "silero-vad"}:
        silero_vad = native_bindings.SileroVadModelConfig(
            model=str(model_path),
            threshold=threshold,
            min_silence_duration=min_silence_duration_sec,
            min_speech_duration=min_speech_duration_sec,
            window_size=512,
            max_speech_duration=max_speech_duration_sec,
        )
        ten_vad = native_bindings.TenVadModelConfig()
    elif normalized_family in {"ten-vad", "tenvad"}:
        silero_vad = native_bindings.SileroVadModelConfig()
        ten_vad = native_bindings.TenVadModelConfig(
            model=str(model_path),
            threshold=threshold,
            min_silence_duration=min_silence_duration_sec,
            min_speech_duration=min_speech_duration_sec,
            window_size=256,
            max_speech_duration=max_speech_duration_sec,
        )
    else:
        raise ValueError(f"Unsupported VAD family: {family}")

    config = native_bindings.VadModelConfig(
        silero_vad=silero_vad,
        ten_vad=ten_vad,
        sample_rate=sample_rate,
        num_threads=DEFAULT_NUM_THREADS,
        provider=DEFAULT_PROVIDER,
        debug=False,
    )

    return native_bindings.VoiceActivityDetector(
        config,
        buffer_size_in_seconds=buffer_size_in_seconds,
    )

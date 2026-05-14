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

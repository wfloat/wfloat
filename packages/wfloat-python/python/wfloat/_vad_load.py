from __future__ import annotations

from pathlib import Path
from typing import Optional

from ._assets import fetch_vad_assets
from ._cache import get_default_cache_dir
from ._core import create_core_vad
from ._vad import DEFAULT_VAD_SAMPLE_RATE, VadModel
from ._vad_assets import cache_vad_model_assets

DEFAULT_VAD_THRESHOLD = 0.5
DEFAULT_VAD_MIN_SILENCE_DURATION_SEC = 0.5
DEFAULT_VAD_MIN_SPEECH_DURATION_SEC = 0.25
DEFAULT_VAD_MAX_SPEECH_DURATION_SEC = 20.0
DEFAULT_VAD_BUFFER_SIZE_IN_SECONDS = 30.0


def _finite_float_or_default(value: Optional[float], default: float) -> float:
    if value is None:
        return default
    resolved = float(value)
    if not resolved == resolved or resolved in {float("inf"), float("-inf")}:
        raise ValueError("VAD timing and threshold options must be finite numbers.")
    return resolved


def load_vad_model(
    model_name: str,
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
    threshold: Optional[float] = None,
    min_silence_duration_sec: Optional[float] = None,
    min_speech_duration_sec: Optional[float] = None,
    max_speech_duration_sec: Optional[float] = None,
    buffer_size_in_seconds: Optional[float] = None,
) -> VadModel:
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    assets = fetch_vad_assets(model_name)
    cached = cache_vad_model_assets(
        model_name,
        assets,
        cache_dir=resolved_cache_dir,
        force_download=force_download,
    )
    family = assets.family

    native_vad = create_core_vad(
        model_name=model_name,
        family=family,
        model_path=cached.require("model"),
        threshold=_finite_float_or_default(threshold, DEFAULT_VAD_THRESHOLD),
        min_silence_duration_sec=_finite_float_or_default(
            min_silence_duration_sec,
            DEFAULT_VAD_MIN_SILENCE_DURATION_SEC,
        ),
        min_speech_duration_sec=_finite_float_or_default(
            min_speech_duration_sec,
            DEFAULT_VAD_MIN_SPEECH_DURATION_SEC,
        ),
        max_speech_duration_sec=_finite_float_or_default(
            max_speech_duration_sec,
            DEFAULT_VAD_MAX_SPEECH_DURATION_SEC,
        ),
        sample_rate=DEFAULT_VAD_SAMPLE_RATE,
        buffer_size_in_seconds=_finite_float_or_default(
            buffer_size_in_seconds,
            DEFAULT_VAD_BUFFER_SIZE_IN_SECONDS,
        ),
    )
    return VadModel(
        model_id=model_name,
        family=family,
        _native_vad=native_vad,
        sample_rate=DEFAULT_VAD_SAMPLE_RATE,
    )


def load_silero_vad(
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
    threshold: Optional[float] = None,
    min_silence_duration_sec: Optional[float] = None,
    min_speech_duration_sec: Optional[float] = None,
    max_speech_duration_sec: Optional[float] = None,
) -> VadModel:
    return load_vad_model(
        "snakers4/silero-vad",
        cache_dir=cache_dir,
        force_download=force_download,
        threshold=threshold,
        min_silence_duration_sec=min_silence_duration_sec,
        min_speech_duration_sec=min_speech_duration_sec,
        max_speech_duration_sec=max_speech_duration_sec,
    )

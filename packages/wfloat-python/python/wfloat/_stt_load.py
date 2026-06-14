from __future__ import annotations

from pathlib import Path
from typing import Optional

from ._assets import fetch_stt_assets
from ._cache import get_default_cache_dir
from ._core import create_core_stt
from ._stt import SttModel
from ._stt_assets import cache_stt_model_assets


def load_stt_model(
    model_name: str,
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
    language: Optional[str] = None,
    task: Optional[str] = None,
    enable_token_timestamps: bool = False,
    enable_segment_timestamps: bool = False,
) -> SttModel:
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    assets = fetch_stt_assets(model_name)
    cached = cache_stt_model_assets(
        model_name,
        assets,
        cache_dir=resolved_cache_dir,
        force_download=force_download,
    )
    family = assets.family

    native_stt = create_core_stt(
        model_name=model_name,
        family=family,
        model_path=cached.files.get("model"),
        tokens_path=cached.require("tokens"),
        preprocessor_path=cached.files.get("preprocessor"),
        encoder_path=cached.files.get("encoder"),
        decoder_path=cached.files.get("decoder"),
        joiner_path=cached.files.get("joiner"),
        uncached_decoder_path=cached.files.get("uncached_decoder"),
        cached_decoder_path=cached.files.get("cached_decoder"),
        language=language,
        task=task,
        enable_token_timestamps=enable_token_timestamps,
        enable_segment_timestamps=enable_segment_timestamps,
    )
    return SttModel(model_id=model_name, _native_stt=native_stt)


def load_whisper_tiny_en(
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
) -> SttModel:
    return load_stt_model(
        "openai/whisper-tiny-en",
        cache_dir=cache_dir,
        force_download=force_download,
        language="en",
        task="transcribe",
    )


def load_moonshine_tiny_en(
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
) -> SttModel:
    return load_stt_model(
        "UsefulSensors/moonshine-tiny",
        cache_dir=cache_dir,
        force_download=force_download,
    )

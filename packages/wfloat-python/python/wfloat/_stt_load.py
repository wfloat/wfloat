from __future__ import annotations

from pathlib import Path
from typing import Optional

from ._assets import fetch_stt_assets
from ._cache import get_default_cache_dir
from ._core import create_core_stt
from ._stt import SttModel
from ._stt_contracts import WHISPER_MODELS, MOONSHINE_V2, ZIPFORMER_LANGUAGES, validate_options
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
    language = validate_options(model_name, language, task)
    if assets.family != "whisper" and (enable_token_timestamps or enable_segment_timestamps):
        raise ValueError("This model has no verified timestamp output")
    if assets.merged_decoder is not None:
        if assets.family != "moonshine" or any((assets.preprocessor, assets.uncached_decoder,
                                                assets.cached_decoder, assets.decoder)):
            raise ValueError("Moonshine v2 merged decoder cannot be combined with v1 decoder paths")
    if model_name == MOONSHINE_V2 and (not assets.encoder or not assets.merged_decoder):
        raise ValueError("Moonshine base v2 requires encoder and merged_decoder assets")
    if model_name in WHISPER_MODELS:
        task = task or "transcribe"
    if model_name in ZIPFORMER_LANGUAGES:
        language = None  # Compatibility check only; the decoder cannot force a language.
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
        # Moonshine v2 reuses the existing ABI decoder slot; v1 leaves it empty.
        decoder_path=cached.files.get("merged_decoder") or cached.files.get("decoder"),
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

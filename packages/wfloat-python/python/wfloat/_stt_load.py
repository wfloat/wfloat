from __future__ import annotations

from pathlib import Path
from typing import Mapping, Optional

from ._assets import fetch_stt_assets
from ._cache import get_default_cache_dir, load_persistent_id, save_persistent_id
from ._core import create_core_stt
from ._stt import SttModel
from ._stt_assets import cache_stt_assets, cache_stt_model_assets


def load_stt_model(
    model_name: str,
    *,
    family: Optional[str] = None,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
    checksums: Optional[Mapping[str, str]] = None,
    model: Optional[str | Path] = None,
    tokens: Optional[str | Path] = None,
    preprocessor: Optional[str | Path] = None,
    encoder: Optional[str | Path] = None,
    decoder: Optional[str | Path] = None,
    joiner: Optional[str | Path] = None,
    uncached_decoder: Optional[str | Path] = None,
    cached_decoder: Optional[str | Path] = None,
    language: Optional[str] = None,
    task: Optional[str] = None,
    enable_token_timestamps: bool = False,
    enable_segment_timestamps: bool = False,
) -> SttModel:
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    explicit_sources = {
        "model": model,
        "tokens": tokens,
        "preprocessor": preprocessor,
        "encoder": encoder,
        "decoder": decoder,
        "joiner": joiner,
        "uncached_decoder": uncached_decoder,
        "cached_decoder": cached_decoder,
    }

    if any(value is not None for value in explicit_sources.values()):
        if not family:
            raise ValueError("family is required when explicit STT asset sources are provided.")
        cached = cache_stt_assets(
            model_name,
            family=family,
            sources=explicit_sources,
            checksums=checksums,
            cache_dir=resolved_cache_dir,
            force_download=force_download,
        )
    else:
        persistent_id = load_persistent_id(resolved_cache_dir)
        assets = fetch_stt_assets(
            model_name,
            family=family,
            persistent_id=persistent_id,
        )
        save_persistent_id(assets.persistent_id or persistent_id, resolved_cache_dir)
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
    encoder_url: str | Path,
    decoder_url: str | Path,
    tokens_url: str | Path,
    encoder_checksum: Optional[str] = None,
    decoder_checksum: Optional[str] = None,
    tokens_checksum: Optional[str] = None,
    force_download: bool = False,
) -> SttModel:
    return load_stt_model(
        "openai/whisper-tiny-en",
        family="whisper",
        cache_dir=cache_dir,
        force_download=force_download,
        checksums={
            key: value
            for key, value in {
                "encoder": encoder_checksum,
                "decoder": decoder_checksum,
                "tokens": tokens_checksum,
            }.items()
            if value is not None
        },
        encoder=encoder_url,
        decoder=decoder_url,
        tokens=tokens_url,
        language="en",
        task="transcribe",
    )


def load_moonshine_tiny_en(
    *,
    cache_dir: Optional[Path] = None,
    preprocessor_url: str | Path,
    encoder_url: str | Path,
    uncached_decoder_url: str | Path,
    cached_decoder_url: str | Path,
    tokens_url: str | Path,
    preprocessor_checksum: Optional[str] = None,
    encoder_checksum: Optional[str] = None,
    uncached_decoder_checksum: Optional[str] = None,
    cached_decoder_checksum: Optional[str] = None,
    tokens_checksum: Optional[str] = None,
    force_download: bool = False,
) -> SttModel:
    return load_stt_model(
        "UsefulSensors/moonshine-tiny",
        family="moonshine",
        cache_dir=cache_dir,
        force_download=force_download,
        checksums={
            key: value
            for key, value in {
                "preprocessor": preprocessor_checksum,
                "encoder": encoder_checksum,
                "uncached_decoder": uncached_decoder_checksum,
                "cached_decoder": cached_decoder_checksum,
                "tokens": tokens_checksum,
            }.items()
            if value is not None
        },
        preprocessor=preprocessor_url,
        encoder=encoder_url,
        uncached_decoder=uncached_decoder_url,
        cached_decoder=cached_decoder_url,
        tokens=tokens_url,
    )

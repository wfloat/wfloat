from __future__ import annotations

from pathlib import Path
from typing import Mapping, Optional

from ._assets import fetch_llm_assets
from ._cache import get_default_cache_dir, load_persistent_id, save_persistent_id
from ._core import create_core_llm
from ._llm import LlmModel
from ._llm_assets import cache_llm_assets, cache_llm_model_assets

DEFAULT_LLM_CONTEXT_SIZE = 2048
DEFAULT_LLM_NUM_THREADS = 4
DEFAULT_LLM_GPU_LAYER_COUNT = 0


def load_llm_model(
    model_name: str,
    *,
    family: Optional[str] = None,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
    checksums: Optional[Mapping[str, str]] = None,
    model: Optional[str | Path] = None,
    context_size: Optional[int] = None,
    num_threads: int = DEFAULT_LLM_NUM_THREADS,
    gpu_layer_count: int = DEFAULT_LLM_GPU_LAYER_COUNT,
    chat_template: Optional[str] = None,
) -> LlmModel:
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()

    if model is not None:
        if not family:
            raise ValueError("family is required when explicit LLM asset sources are provided.")
        cached = cache_llm_assets(
            model_name,
            family=family,
            sources={"model": model},
            checksums=checksums,
            cache_dir=resolved_cache_dir,
            force_download=force_download,
            context_size=context_size,
            chat_template=chat_template,
        )
    else:
        persistent_id = load_persistent_id(resolved_cache_dir)
        assets = fetch_llm_assets(
            model_name,
            family=family,
            persistent_id=persistent_id,
        )
        save_persistent_id(assets.persistent_id or persistent_id, resolved_cache_dir)
        cached = cache_llm_model_assets(
            model_name,
            assets,
            cache_dir=resolved_cache_dir,
            force_download=force_download,
        )
        family = assets.family

    if family is None:
        raise ValueError("family is required to load an LLM model.")

    resolved_context_size = (
        int(context_size)
        if context_size is not None
        else int(cached.context_size or DEFAULT_LLM_CONTEXT_SIZE)
    )
    resolved_chat_template = chat_template if chat_template is not None else cached.chat_template
    if resolved_chat_template is None and getattr(cached, "chat_template_format", None) == "chatml":
        resolved_chat_template = "chatml"

    native_llm = create_core_llm(
        model_name=model_name,
        family=family,
        model_path=cached.require("model"),
        context_size=resolved_context_size,
        num_threads=num_threads,
        gpu_layer_count=gpu_layer_count,
        chat_template=resolved_chat_template,
    )

    return LlmModel(
        model_id=model_name,
        family=family,
        _native_llm=native_llm,
        context_size=resolved_context_size,
    )

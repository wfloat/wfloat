"""Registry-backed synchronous language model loading."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from ._assets import fetch_llm_assets
from ._cache import get_default_cache_dir
from ._language import LanguageModel
from ._lifecycle import load_with_lifecycle
from ._llm_assets import cache_llm_model_assets
from ._llm_bridge import NativeLanguageBackend


def load_language_model(model_id: str, *, cache_dir: Optional[Path] = None,
                        context_size: Optional[int] = None, num_threads: int = 4,
                        chat_template: Optional[str] = None, on_progress=None,
                        cancel_event=None) -> LanguageModel:
    """Download if needed, then load a model. unload() keeps downloaded files."""
    if context_size is not None and (isinstance(context_size, bool) or not isinstance(context_size, int) or context_size <= 0):
        raise ValueError("context_size must be a positive integer")
    if isinstance(num_threads, bool) or not isinstance(num_threads, int) or num_threads <= 0:
        raise ValueError("num_threads must be a positive integer")
    if chat_template is not None and not isinstance(chat_template, str):
        raise TypeError("chat_template must be a string or None")
    assets = fetch_llm_assets(model_id)
    root = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()

    def initialize(lease):
        cached = cache_llm_model_assets(model_id, assets, cache_dir=root, force_download=False)
        template = chat_template if chat_template is not None else cached.chat_template
        if template is None and cached.chat_template_format == "chatml":
            template = "chatml"
        backend = NativeLanguageBackend(cached.require("model"),
            context_size=context_size if context_size is not None else (cached.context_size or 4096),
            num_threads=num_threads, chat_template=template)
        try:
            return LanguageModel(backend, model_id, asset_lease=lease)
        except BaseException:
            backend.unload()
            raise

    return load_with_lifecycle(model_id, initialize, cache_dir=root,
                               on_progress=on_progress, cancel_event=cancel_event)

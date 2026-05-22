from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Optional, Sequence

from ._results import LlmGenerationResult


@dataclass
class LlmModel:
    model_id: str
    family: str
    _native_llm: object
    context_size: int = 0

    def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 128,
        temperature: float = 0.8,
        top_p: float = 0.95,
        top_k: int = 40,
        repeat_penalty: float = 1.0,
        seed: int = 0,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> LlmGenerationResult:
        if not hasattr(self._native_llm, "generate"):
            raise RuntimeError("Native LLM backend does not support generate().")

        return self._native_llm.generate(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
            seed=seed,
            on_token=on_token,
        )

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        *,
        max_tokens: int = 128,
        temperature: float = 0.8,
        top_p: float = 0.95,
        top_k: int = 40,
        repeat_penalty: float = 1.0,
        seed: int = 0,
        on_token: Optional[Callable[[str], None]] = None,
    ) -> LlmGenerationResult:
        if not hasattr(self._native_llm, "chat"):
            raise RuntimeError("Native LLM backend does not support chat().")

        return self._native_llm.chat(
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
            seed=seed,
            on_token=on_token,
        )

    def format_chat(
        self,
        messages: Sequence[Dict[str, str]],
        *,
        add_generation_prompt: bool = True,
    ) -> str:
        if not hasattr(self._native_llm, "format_chat"):
            raise RuntimeError("Native LLM backend does not support format_chat().")

        return self._native_llm.format_chat(
            messages,
            add_generation_prompt=add_generation_prompt,
        )

    def close(self) -> None:
        if hasattr(self._native_llm, "close"):
            self._native_llm.close()

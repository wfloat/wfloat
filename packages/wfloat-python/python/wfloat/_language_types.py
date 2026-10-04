"""Value objects for synchronous language generation.

History uses portable message dictionaries; dictionary or dataclass messages are
accepted on input. Parsed tool arguments and structured output may be typed
objects, while the arguments recorded in history remain the original JSON.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar, Union, Optional


T = TypeVar("T")


@dataclass
class ToolCall(Generic[T]):
    id: str
    name: str
    arguments: T


StopReason = Literal["complete", "tool_calls", "max_rounds", "stop_condition",
                     "max_tokens", "cancelled", "context_limit", "stop_string"]


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class ContextLimit:
    phase: Literal["input", "generation"]
    capacity_tokens: int
    input_tokens: int


@dataclass
class GenerationRound:
    round_index: int
    text: str
    new_messages: list[dict[str, Any]]


@dataclass
class PartialGenerationResult:
    text: str
    new_messages: list[dict[str, Any]]
    rounds: list[GenerationRound]


@dataclass
class GenerationResult(PartialGenerationResult):
    stop_reason: StopReason
    duration_ms: float
    usage: Usage
    tool_calls: list[ToolCall[Any]] = field(default_factory=list)
    output: Any = None
    context_limit: Optional[ContextLimit] = None


class GenerationError(Exception):
    """Generation failed; partial_result contains replayable history.

    The originating exception is available as Python's ``__cause__``.
    Application callback exceptions instead propagate unchanged.
    """

    def __init__(self, message: str, partial_result: PartialGenerationResult):
        super().__init__(message)
        self.partial_result = partial_result


@dataclass
class StructuredOutput:
    schema: Any
    max_correction_attempts: int = 0


@dataclass
class StopContext:
    messages: list[dict[str, Any]]
    rounds: list[GenerationRound]
    latest_round: GenerationRound


@dataclass
class RoundStartEvent:
    round_index: int
    type: Literal["round_start"] = field(default="round_start", init=False)


@dataclass
class TextEvent:
    text: str
    round_index: int
    type: Literal["text"] = field(default="text", init=False)


@dataclass
class ReasoningEvent:
    text: str
    round_index: int
    type: Literal["reasoning"] = field(default="reasoning", init=False)


@dataclass
class ToolCallEvent:
    call: ToolCall[Any]
    round_index: int
    type: Literal["tool_call"] = field(default="tool_call", init=False)


@dataclass
class ToolStartEvent:
    call: ToolCall[Any]
    round_index: int
    type: Literal["tool_start"] = field(default="tool_start", init=False)


@dataclass
class ToolResultEvent:
    call: ToolCall[Any]
    round_index: int
    output: Any
    type: Literal["tool_result"] = field(default="tool_result", init=False)


@dataclass
class ToolErrorEvent:
    call: ToolCall[Any]
    round_index: int
    error: BaseException
    type: Literal["tool_error"] = field(default="tool_error", init=False)


@dataclass
class ToolCancelEvent:
    call: ToolCall[Any]
    round_index: int
    type: Literal["tool_cancel"] = field(default="tool_cancel", init=False)


@dataclass
class ToolValidationError:
    code: Literal["unknown_tool", "invalid_arguments"]
    message: str


@dataclass
class ToolValidationErrorEvent:
    request: ToolCall[Any]
    round_index: int
    error: ToolValidationError
    type: Literal["tool_validation_error"] = field(default="tool_validation_error", init=False)


GenerationEvent = Union[RoundStartEvent, TextEvent, ReasoningEvent, ToolCallEvent,
                        ToolStartEvent, ToolResultEvent, ToolErrorEvent,
                        ToolCancelEvent, ToolValidationErrorEvent]

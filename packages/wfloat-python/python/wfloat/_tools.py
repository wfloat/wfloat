"""Tool definitions and synchronous execution helpers; scheduling belongs to LLM."""
from __future__ import annotations

from dataclasses import dataclass, field
import inspect
from threading import Event
from typing import Any, Callable, Generic, TypeVar, Optional

from ._schemas import SchemaAdapter, json_snapshot, normalize_schema

T = TypeVar("T")
R = TypeVar("R")


@dataclass(frozen=True)
class ToolContext:
    """Operation cancellation signal. Executors must cooperate; never clear it."""

    cancel_event: Event


class ToolOutputError(TypeError):
    """Unsupported executor output; operation failure, not tool-error feedback."""


def validate_tool_output(value: Any) -> Any:
    """Return an owned JSON snapshot, including None; never stringify objects."""
    try:
        return json_snapshot(value)
    except TypeError as error:
        raise ToolOutputError(str(error)) from error


@dataclass(frozen=True)
class ToolDefinition(Generic[T, R]):
    name: str
    input_schema: SchemaAdapter[T]
    execute: Optional[Callable[..., R]] = None
    description: Optional[str] = None
    _with_context: bool = field(default=False, init=False, repr=False)

    def __post_init__(self):
        with_context = _check_definition(self.name, self.execute, self.description)
        object.__setattr__(self, "input_schema", normalize_schema(self.input_schema))
        object.__setattr__(self, "_with_context", with_context)

    @property
    def json_schema(self) -> dict:
        return self.input_schema.json_schema

    def parse_arguments(self, raw_arguments: Any) -> T:
        """Validate/transform a snapshot; retain raw_arguments separately in history."""
        return self.input_schema.parse(raw_arguments)

    def invoke(self, arguments: T, *, context: Optional[ToolContext] = None) -> Any:
        """Execute already parsed arguments exactly once and validate its output.

        The parent owns scheduling, cancellation/late-result policy and errors.
        It must call parse_arguments first and pass the operation's ToolContext.
        """
        if self.execute is None:
            raise TypeError(f"Manual tool {self.name!r} has no executor")
        if self._with_context:
            if context is None:
                raise TypeError("This executor requires the operation's ToolContext")
            result = self.execute(arguments, context=context)
        else:
            result = self.execute(arguments)
        if inspect.isawaitable(result):
            if inspect.iscoroutine(result):
                result.close()
            raise ToolOutputError("Async tool executors are unsupported")
        return validate_tool_output(result)


def define_tool(name: str, input_schema: Any, *, execute: Optional[Callable[..., R]] = None,
                description: Optional[str] = None) -> ToolDefinition[Any, R]:
    """Preflight a schema and executor without invoking user code.

    Inject context only for an explicitly declared keyword-only ``context``.
    A catch-all **kwargs does not opt in. Executors take one positional parsed
    argument; all other required parameters must be satisfiable at definition.
    """
    return ToolDefinition(name, input_schema, execute, description)


def _check_definition(name, execute, description):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Tool name must be a nonempty string")
    if description is not None and not isinstance(description, str):
        raise TypeError("Tool description must be a string or None")
    with_context = False
    if execute is not None:
        if not callable(execute):
            raise TypeError("Tool execute must be callable")
        target = execute if inspect.isfunction(execute) or inspect.ismethod(execute) else execute.__call__
        if (inspect.iscoroutinefunction(execute) or inspect.isasyncgenfunction(execute)
                or inspect.iscoroutinefunction(target) or inspect.isasyncgenfunction(target)):
            raise TypeError("Async tool executors are unsupported")
        try:
            signature = inspect.signature(execute)
        except (TypeError, ValueError) as error:
            raise TypeError("Tool executor must have an inspectable signature") from error
        parameter = signature.parameters.get("context")
        with_context = parameter is not None and parameter.kind is inspect.Parameter.KEYWORD_ONLY
        try:
            signature.bind(object(), **({"context": object()} if with_context else {}))
        except TypeError as error:
            raise TypeError("Executor must accept one parsed argument and optional keyword-only context") from error
    return with_context


def execute_tool(tool: ToolDefinition[T, R], args: T, context: ToolContext) -> Any:
    """Invoke already parsed arguments; parent retains raw history separately."""
    return tool.invoke(args, context=context)

"""Demand-driven language orchestration over the native round protocol.

A model supports one active operation at a time. Different calling threads queue
in FIFO order; same-thread reentrant use is rejected to avoid self-deadlock. Streams are lazy,
single pass, and must be closed (normally with ``with``). Worker tools are daemon
threads: cancellation signals them but cannot forcibly stop their side effects.
"""
from __future__ import annotations

import copy
import inspect
import json
import math
import queue
import threading
import time
import warnings
from collections import deque
from contextvars import ContextVar
from functools import wraps
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterator, Protocol, Optional, TypeVar, Union, cast

from ._operations import CancellationEvent, OperationCancelledError
from ._language_types import (
    ContextLimit, GenerationError, GenerationEvent, GenerationResult,
    GenerationRound, PartialGenerationResult, ReasoningEvent, RoundStartEvent,
    StopContext, StructuredOutput, TextEvent, ToolCallEvent, ToolCancelEvent,
    ToolErrorEvent, ToolResultEvent, ToolStartEvent, ToolValidationError,
    ToolValidationErrorEvent, Usage, ToolCall,
)


class LanguageBackend(Protocol):
    context_size: int

    def round(self, request: dict, cancel_event: CancellationEvent) -> Iterator[dict]: ...
    def inspect_input(self, request: dict) -> dict: ...
    def unload(self) -> None: ...


_CAMEL = {
    'tool_calls': 'toolCalls', 'max_rounds': 'maxRounds',
    'stop_condition': 'stopCondition', 'max_tokens': 'maxTokens',
    'context_limit': 'contextLimit', 'stop_string': 'stopString',
    'not_executed': 'notExecuted', 'outcome_unknown': 'outcomeUnknown',
    'invalid_arguments': 'invalidArguments', 'unknown_tool': 'unknownTool',
}
_SNAKE = {value: key for key, value in _CAMEL.items()}
_TOOL_THREAD = threading.local()
_SAMPLING = {'temperature': 'temperature', 'top_p': 'topP', 'top_k': 'topK',
             'min_p': 'minP', 'repetition_penalty': 'repetitionPenalty',
             'presence_penalty': 'presencePenalty', 'frequency_penalty': 'frequencyPenalty',
             'seed': 'seed'}


def _utc_now() -> str:
    """Message creation metadata; monotonic time remains used for duration."""
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _json_value(value, seen=None):
    """Validate strictly; json.dumps alone coerces non-string dictionary keys."""
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) not in (dict, list):
        raise TypeError('Tool output/arguments must be finite JSON values')
    seen = set() if seen is None else seen
    if id(value) in seen:
        raise TypeError('JSON values must be acyclic')
    seen.add(id(value))
    if isinstance(value, dict) and any(type(key) is not str for key in value):
        raise TypeError('JSON object keys must be strings')
    for item in value.values() if isinstance(value, dict) else value:
        _json_value(item, seen)
    seen.remove(id(value))


def _record(value):
    return asdict(value) if is_dataclass(value) and not isinstance(value, type) else value


def _messages(messages):
    if not isinstance(messages, (list, tuple)):
        raise TypeError('messages must be a sequence of messages')
    result = []
    for item in messages:
        m = copy.deepcopy(_record(item))
        if not isinstance(m, dict) or m.get('role') not in ('system', 'user', 'assistant', 'tool'):
            raise TypeError('Invalid message role')
        if 'createdAt' in m:
            m['created_at'] = m.pop('createdAt')
        if m.get('created_at') is not None and not isinstance(m['created_at'], str):
            raise TypeError('created_at must be a string')
        if m['role'] == 'tool':
            if 'callId' in m:
                m['call_id'] = m.pop('callId')
            if not isinstance(m.get('call_id'), str):
                raise TypeError('Tool messages require call_id')
            m['status'] = _SNAKE.get(m.get('status'), m.get('status'))
            if m['status'] == 'completed':
                if 'output' not in m:
                    raise TypeError('Completed tool messages require output')
                _json_value(m['output'])
            elif m['status'] in ('failed', 'invalid_arguments', 'unknown_tool'):
                if not isinstance(m.get('error'), dict) or not isinstance(m['error'].get('message'), str):
                    raise TypeError('Tool error requires a message')
            elif m['status'] not in ('not_executed', 'outcome_unknown'):
                raise TypeError('Invalid tool status')
        elif isinstance(m.get('content'), str):
            pass
        elif m['role'] == 'assistant' and isinstance(m.get('content'), list):
            parts = []
            for item in m['content']:
                p = _record(item)
                if not isinstance(p, dict):
                    raise TypeError('Invalid assistant part')
                if p.get('type') in ('text', 'reasoning'):
                    if not isinstance(p.get('text'), str):
                        raise TypeError('Assistant text must be a string')
                elif p.get('type') in ('toolCall', 'tool_call'):
                    p['type'] = 'tool_call'
                    if not isinstance(p.get('id'), str) or not isinstance(p.get('name'), str) or 'arguments' not in p:
                        raise TypeError('Invalid assistant tool call')
                    _json_value(p['arguments'])
                else:
                    raise TypeError('Invalid assistant part type')
                parts.append(p)
            m['content'] = parts
        else:
            raise TypeError('Invalid message content')
        result.append(m)
    return result


def _wire_messages(messages):
    result = copy.deepcopy(messages)
    for m in result:
        if 'created_at' in m:
            m['createdAt'] = m.pop('created_at')
        if m['role'] == 'tool':
            m['callId'] = m.pop('call_id')
            m['status'] = _CAMEL.get(m['status'], m['status'])
        elif m['role'] == 'assistant' and isinstance(m['content'], list):
            for p in m['content']:
                if p['type'] == 'tool_call':
                    p['type'] = 'toolCall'
    return result


class _StopFilter:
    def __init__(self, strings):
        self.strings, self.pending, self.stopped = strings, '', False

    def push(self, text):
        if self.stopped:
            return ''
        self.pending += text
        found = [(self.pending.index(s) + len(s), self.pending.index(s))
                 for s in self.strings if s in self.pending]
        if found:
            # Earliest completed match wins, including overlapping stop strings.
            end, start = min(found, key=lambda pair: pair[0])
            output, self.pending, self.stopped = self.pending[:start], '', True
            return output
        keep = max((n for s in self.strings for n in range(1, min(len(s), len(self.pending) + 1))
                    if self.pending.endswith(s[:n])), default=0)
        split = len(self.pending) - keep
        output, self.pending = self.pending[:split], self.pending[split:]
        return output

    def flush(self):
        output, self.pending = self.pending, ''
        return output


def _positive(name, value, minimum=1):
    if type(value) is not int or value < minimum:
        raise TypeError(f'{name} must be an integer >= {minimum}')


_explicit_max_rounds = ContextVar('wfloat_explicit_max_rounds', default=False)
_Method = TypeVar('_Method', bound=Callable[..., Any])


def _track_explicit_round_budget(method: _Method) -> _Method:
    # Keep max_rounds=20 and keyword-only public signatures, without a public
    # sentinel. Binding alone loses whether the caller supplied the default.
    @wraps(method)
    def wrapped(*args, **kwargs):
        token = _explicit_max_rounds.set('max_rounds' in kwargs)
        try:
            return method(*args, **kwargs)
        finally:
            _explicit_max_rounds.reset(token)
    return cast(_Method, wrapped)


def _prepare(options, *, explicit_max_rounds=False):
    from ._schemas import normalize_schema
    from ._tools import ToolDefinition
    _positive('max_rounds', options['max_rounds'])
    for name in ('max_tokens_per_round', 'max_concurrent_tools'):
        if options[name] is not None:
            _positive(name, options[name])
    for name, allowed in (('tool_execution', ('sequential', 'parallel')),
                          ('tool_execution_timing', ('immediate', 'after_generation')),
                          ('tool_error_behavior', ('continue', 'stop'))):
        if options[name] not in allowed:
            raise ValueError(f'Invalid {name}')
    if options['max_concurrent_tools'] is not None and options['tool_execution'] != 'parallel':
        raise ValueError('max_concurrent_tools requires parallel tool_execution')
    if options['reasoning'] is not None and type(options['reasoning']) is not bool:
        raise TypeError('reasoning must be a boolean')
    for name, value in options.items():
        if (name.startswith('on_') or name == 'stop_when') and value is not None and not callable(value):
            raise TypeError(f'{name} must be callable')
        if (name.startswith('on_') or name == 'stop_when') and inspect.iscoroutinefunction(value):
            raise TypeError(f'{name} must be synchronous')
    for name in _SAMPLING:
        value = options[name]
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
            raise TypeError(f'{name} must be finite')
    for name in ('top_p', 'min_p'):
        if options[name] is not None and not 0 <= options[name] <= 1:
            raise ValueError(f'{name} must be between zero and one')
    if options['temperature'] is not None and options['temperature'] < 0:
        raise ValueError('temperature cannot be negative')
    if options['repetition_penalty'] is not None and options['repetition_penalty'] <= 0:
        raise ValueError('repetition_penalty must be positive')
    for name in ('top_k', 'seed'):
        if options[name] is not None:
            _positive(name, options[name], 0)
    if options['seed'] is not None and options['seed'] > 0xffffffff:
        raise ValueError('seed must be an unsigned 32-bit integer')
    strings = options['stop_strings']
    if strings is None:
        strings = ()
    if not isinstance(strings, (list, tuple)) or any(not isinstance(s, str) or not s for s in strings):
        raise TypeError('stop_strings must contain nonempty strings')
    options['stop_strings'] = tuple(strings)
    supplied = options['tools']
    tools, schemas = {}, {}
    if supplied is not None:
        if isinstance(supplied, dict):
            entries = supplied.items()
        elif isinstance(supplied, (list, tuple)):
            entries = [(getattr(t, 'name', None), t) for t in supplied]
        else:
            raise TypeError('tools must be a sequence or mapping of tool definitions')
        for name, definition in entries:
            if not isinstance(name, str) or not name.strip() or name in tools:
                raise ValueError('Tool names must be unique nonempty strings')
            if isinstance(definition, dict):
                d = dict(definition)
            else:
                d = {key: getattr(definition, key, None) for key in ('description', 'input_schema', 'execute')}
            if 'input_schema' not in d or d['input_schema'] is None:
                raise TypeError('Tools require input_schema')
            execute = d.get('execute')
            if execute is not None and (not callable(execute) or inspect.iscoroutinefunction(execute)):
                raise TypeError('Tool execute must be synchronous and callable')
            d['execute'] = execute
            d['definition'] = ToolDefinition(name, d['input_schema'], execute, d.get('description'))
            tools[name] = d
            schemas[name] = d['definition'].input_schema
        managed = [d['execute'] is not None for d in tools.values()]
        if any(managed) and not all(managed):
            raise TypeError('Tools must either all define execute or all be manual')
    output_schema = None
    structured = options['structured_output']
    options['corrections'] = 0
    if structured is not None:
        if tools:
            raise ValueError('structured_output and tools cannot be combined')
        structured = _record(structured)
        if not isinstance(structured, dict) or 'schema' not in structured:
            raise TypeError('structured_output requires schema')
        attempts = structured.get('max_correction_attempts', 0)
        _positive('max_correction_attempts', attempts, 0)
        options['corrections'] = attempts
        output_schema = normalize_schema(structured['schema'])
        if (explicit_max_rounds and 'max_correction_attempts' in structured
                and attempts > options['max_rounds'] - 1):
            warnings.warn(
                'Wfloat: max_rounds limits the configured structured-output correction attempts.',
                RuntimeWarning, stacklevel=5,
            )
    options['tools'] = tools
    return schemas, output_schema


class LanguageModel:
    """Loaded model. Options are keyword-only; generation is synchronous.

    Operations on different threads queue in FIFO order. Finish or close a live
    stream before starting another operation on the same thread. Tool executors
    must not synchronously call the same model (the active operation awaits them).
    """

    def __init__(self, backend: LanguageBackend, model_id: Optional[str] = None, *, asset_lease=None):
        self._backend, self.model_id = backend, model_id
        self._asset_lease = asset_lease
        self._identity = object()
        self.context_size = backend.context_size
        self._condition = threading.Condition()
        self._active = None
        self._waiting = deque()
        self._streams = set()
        self._closed = False
        self._unloaded = False

    def _ensure_open(self):
        if self._closed:
            raise RuntimeError('The model has been unloaded')

    def _claim(self, operation):
        with self._condition:
            if operation.cancel_event.is_set():
                return False
            self._ensure_open()
            if getattr(_TOOL_THREAD, 'model_identity', None) is self._identity:
                raise RuntimeError('A managed tool cannot synchronously call its own active model')
            if self._active is not None and self._active._owner_thread == threading.get_ident():
                raise RuntimeError('The model already has an active operation on this thread; finish or close it first')
            self._waiting.append(operation)
            try:
                while self._active is not None or self._waiting[0] is not operation:
                    if operation.cancel_event.is_set():
                        return False
                    self._condition.wait(0.02)
                if operation.cancel_event.is_set():
                    return False
                self._ensure_open()
                self._active = operation
                operation._owner_thread = threading.get_ident()
                return True
            finally:
                self._waiting.remove(operation)
                self._condition.notify_all()

    def _release(self, operation):
        with self._condition:
            if self._active is operation:
                self._active = None
            self._streams.discard(operation)
            self._condition.notify_all()

    @_track_explicit_round_budget
    def generate(self, messages, *, tools=None, tool_execution='sequential',
                 max_concurrent_tools=None, tool_execution_timing='immediate',
                 tool_error_behavior='continue', max_rounds=20, max_tokens_per_round=None,
                 reasoning=None, stop_strings=None, structured_output=None, stop_when=None,
                 temperature=None, top_p=None, top_k=None, min_p=None,
                 repetition_penalty=None, presence_penalty=None, frequency_penalty=None,
                 seed=None, cancel_event=None, on_text=None, on_reasoning=None,
                 on_round_start=None, on_tool_call=None, on_tool_start=None,
                 on_tool_result=None, on_tool_error=None, on_tool_cancel=None,
                 on_tool_validation_error=None) -> GenerationResult:
        options = dict(locals())
        del options['self'], options['messages'], options['cancel_event']
        with self._create_stream(messages, options, cancel_event) as stream:
            return stream.result()

    @_track_explicit_round_budget
    def generate_stream(self, messages, *, tools=None, tool_execution='sequential',
                        max_concurrent_tools=None, tool_execution_timing='immediate',
                        tool_error_behavior='continue', max_rounds=20, max_tokens_per_round=None,
                        reasoning=None, stop_strings=None, structured_output=None, stop_when=None,
                        temperature=None, top_p=None, top_k=None, min_p=None,
                        repetition_penalty=None, presence_penalty=None, frequency_penalty=None,
                        seed=None, cancel_event=None, on_text=None, on_reasoning=None,
                        on_round_start=None, on_tool_call=None, on_tool_start=None,
                        on_tool_result=None, on_tool_error=None, on_tool_cancel=None,
                        on_tool_validation_error=None) -> LanguageStream:
        options = dict(locals())
        del options['self'], options['messages'], options['cancel_event']
        return self._create_stream(messages, options, cancel_event)

    def _create_stream(self, messages, options, cancel_event):
        self._ensure_open()
        event = CancellationEvent(cancel_event)
        input_messages = _messages(messages)
        schemas, output = _prepare(options, explicit_max_rounds=_explicit_max_rounds.get())
        stream = LanguageStream(self, input_messages, options, schemas, output, event)
        with self._condition:
            self._ensure_open()
            self._streams.add(stream)
        return stream

    def count_input_tokens(self, messages, *, tools=None, reasoning=None, structured_output=None) -> int:
        # Reuse eager schema/options validation without starting generation.
        stream = self.generate_stream(messages, tools=tools, reasoning=reasoning,
                                      structured_output=structured_output)
        stream._enter_drive()
        try:
            if not self._claim(stream):
                raise OperationCancelledError("Input inspection cancelled by unload")
            info = self._backend.inspect_input(stream._request([]))
            return info['inputTokens'] if 'inputTokens' in info else info['input_tokens']
        finally:
            stream._leave_drive()
            stream.close()
            self._release(stream)

    def unload(self):
        with self._condition:
            if self._unloaded:
                if self._asset_lease is not None:
                    self._asset_lease.release()
                    self._asset_lease = None
                return
            if self._active is not None and self._active._driver == threading.get_ident():
                raise RuntimeError('Cannot unload the model from its active callback')
            self._closed = True
            streams = list(self._streams)
        for stream in streams:
            stream.close()
        with self._condition:
            while self._active is not None:
                self._condition.wait()
            if not self._unloaded:
                self._backend.unload()
                self._unloaded = True
                if self._asset_lease is not None:
                    self._asset_lease.release()
                    self._asset_lease = None

    def __enter__(self):
        self._ensure_open()
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.unload()
        except BaseException:
            if exc_type is None:
                raise
        return False


@dataclass
class _CallState:
    call: Any
    round_index: int
    definition: dict
    started: bool = False
    outcome: Optional[dict] = None
    interrupted_at: Optional[str] = None


class _Cancelled(Exception):
    pass


class LanguageStream(Iterator[GenerationEvent]):
    """Single-pass stream; result() drains and caches the result.

    Callbacks accompany events when next()/result() drives the stream, on that
    calling thread. Pausing stops inference and new tool scheduling. Already
    started tools may continue. close()/context exit signals them without joining
    uncooperative workers, suppresses subsequent callbacks, and caches a cancelled
    partial result. Failed streams re-raise their original exception from result().
    """

    def __init__(self, model, messages, options, schemas, output_schema, event):
        self._model, self._input, self._options = model, messages, options
        self._schemas, self._output_schema = schemas, output_schema
        self.cancel_event = event
        self._lock = threading.Lock()
        self._driver = None
        self._owner_thread = None
        self._iterator = None
        self._result = None
        self._error = None
        self._states = []
        self._calls = []
        self._ids = set()
        self._usage = Usage()
        self._pending = deque()
        self._running = 0
        self._completed = queue.Queue()
        self._started_at = None
        self._native = None
        self._filter = None
        self._round_cancel = None
        self._callback_error = None
        self._validated_text = None
        self._validated_output = None
        self._close_requested = False

    def __iter__(self):
        return self

    def _enter_drive(self):
        if not self._lock.acquire(False):
            raise RuntimeError('Concurrent or reentrant stream consumption is not supported')
        self._driver = threading.get_ident()
        if self._iterator is not None:
            self._owner_thread = self._driver

    def _leave_drive(self):
        try:
            # A close can race with the last instruction of next(), after its
            # event was prepared. Finish cleanup before relinquishing the driver.
            if self._close_requested and self._result is None and self._error is None:
                self._cleanup(suppress=True)
                self._finish('cancelled')
                self._model._release(self)
        finally:
            self._driver = None
            self._lock.release()

    def __next__(self):
        self._enter_drive()
        try:
            return self._next()
        finally:
            self._leave_drive()

    def _next(self):
        if self._error is not None or self._result is not None:
            raise StopIteration
        try:
            if self._iterator is None:
                if not self._model._claim(self):
                    self._finish('cancelled')
                    self._model._release(self)
                    raise StopIteration
                self._iterator = self._run()
            event = next(self._iterator)
            if self._close_requested:
                self._cleanup(suppress=True)
                self._finish('cancelled')
                self._model._release(self)
                raise StopIteration
            callback = self._options.get('on_' + event.type)
            if callback is not None:
                # Outside _run's GenerationError wrapper: application errors retain identity.
                returned = callback(event.text if event.type in ('text', 'reasoning') else event)
                if inspect.isawaitable(returned):
                    if inspect.iscoroutine(returned):
                        returned.close()
                    raise TypeError('Callbacks must be synchronous')
            if self._close_requested:
                self._cleanup(suppress=True)
                self._finish('cancelled')
                self._model._release(self)
                raise StopIteration
            return event
        except StopIteration as error:
            if self._result is not None:
                raise
            self._error = error
            self.cancel_event.set()
            self._cleanup(suppress=True)
            self._model._release(self)
            raise
        except BaseException as error:
            # PEP 479 wraps a predicate's StopIteration at a generator boundary.
            # result() must still report the application's original exception.
            if self._callback_error is not None:
                error = self._callback_error
            self._error = error
            self.cancel_event.set()
            self._cleanup(suppress=True)
            self._model._release(self)
            raise error

    def result(self) -> GenerationResult:
        self._enter_drive()
        try:
            while self._result is None and self._error is None:
                try:
                    self._next()
                except StopIteration:
                    break
            if self._error is not None:
                raise self._error
            return self._result
        finally:
            self._leave_drive()

    def cancel(self):
        if self._result is None and self._error is None:
            self.cancel_event.set()

    def close(self):
        if self._result is not None or self._error is not None:
            return
        self._close_requested = True
        self.cancel_event.set()
        if not self._lock.acquire(False):
            return  # The active driver cleans up at the next native safe boundary.
        try:
            self._cleanup(suppress=True)
            self._finish('cancelled')
            self._model._release(self)
        finally:
            self._lock.release()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _cleanup(self, suppress=False):
        try:
            if self._iterator is not None:
                self._iterator.close()
        except BaseException:
            if not suppress:
                raise

    def _check(self):
        if self.cancel_event.is_set():
            raise _Cancelled()

    def _partial(self):
        rounds = []
        for state in self._states:
            messages = []
            if state['parts']:
                messages.append({'role': 'assistant', 'content': copy.deepcopy(state['parts']),
                                 'created_at': state['created_at']})
            for item in state['outcomes']:
                if isinstance(item, dict):
                    messages.append(copy.deepcopy(item))
                elif item.outcome is not None:
                    messages.append(copy.deepcopy(item.outcome))
                elif item.definition['execute'] is not None:
                    # This timestamps the interruption record, never a claimed
                    # successful completion of an unobserved worker outcome.
                    if item.interrupted_at is None:
                        item.interrupted_at = _utc_now()
                    messages.append({'role': 'tool', 'call_id': item.call.id,
                                     'status': 'outcome_unknown' if item.started else 'not_executed',
                                     'created_at': item.interrupted_at})
            rounds.append(GenerationRound(state['index'], state['text'], messages))
        return PartialGenerationResult(rounds[-1].text if rounds else '',
                                       [m for r in rounds for m in r.new_messages], rounds)

    def _finish(self, reason, output=None, context_limit=None):
        if self._result is not None:
            return
        partial = self._partial()
        if reason == 'cancelled' and self._output_schema is not None:
            output = self._cancelled_output(partial.text)
        elapsed = 0 if self._started_at is None else (time.monotonic() - self._started_at) * 1000
        self._result = GenerationResult(partial.text, partial.new_messages, partial.rounds,
                                        reason, elapsed, copy.copy(self._usage),
                                        [copy.copy(call) for call in self._calls], output, context_limit)

    def _cancelled_output(self, text):
        if self._validated_text == text:
            return self._validated_output
        # Arbitrary schema transforms cannot hold Stop indefinitely. The worker
        # owns only immutable text and an adapter, never a native model pointer.
        completed = queue.Queue(maxsize=1)
        schema = self._output_schema
        def validate():
            try:
                completed.put(schema.parse(json.loads(text)))
            except BaseException:
                completed.put(None)
        worker = threading.Thread(target=validate, daemon=True, name='wfloat-cancel-validation')
        worker.start()
        try:
            return completed.get(timeout=0.1)
        except queue.Empty:
            return None

    def _request(self, past):
        request = {'messages': _wire_messages(self._input + past)}
        for key, wire in _SAMPLING.items():
            if self._options[key] is not None:
                request[wire] = self._options[key]
        for key, wire in (('reasoning', 'reasoning'), ('max_tokens_per_round', 'maxTokensPerRound')):
            if self._options[key] is not None:
                request[wire] = self._options[key]
        if self._schemas:
            request['tools'] = {name: {'description': self._options['tools'][name].get('description'),
                                      'inputSchema': copy.deepcopy(schema.json_schema)}
                                for name, schema in self._schemas.items()}
        if self._output_schema is not None:
            request['structuredOutput'] = copy.deepcopy(self._output_schema.json_schema)
        return request

    def _append(self, state, kind, text):
        if not text:
            return None
        parts = state['parts']
        if not parts:
            state['created_at'] = _utc_now()
        if parts and parts[-1]['type'] == kind:
            parts[-1]['text'] += text
        else:
            parts.append({'type': kind, 'text': text})
        if kind == 'text':
            state['text'] += text
        return (TextEvent if kind == 'text' else ReasoningEvent)(text, state['index'])

    def _receive(self, raw, state):
        from ._schemas import SchemaValidationError
        if not isinstance(raw, dict) or not isinstance(raw.get('id'), str) or not isinstance(raw.get('name'), str) or 'arguments' not in raw:
            raise TypeError('Invalid backend tool call')
        _json_value(raw['arguments'])
        raw = copy.deepcopy(raw)
        if raw['id'] in self._ids:
            raise ValueError(f'The backend repeated tool invocation ID {raw["id"]}')
        self._ids.add(raw['id'])
        if not state['parts']:
            state['created_at'] = _utc_now()
        state['parts'].append({'type': 'tool_call', **raw})
        request = ToolCall(**raw)
        definition = self._options['tools'].get(raw['name'])
        validating = None
        outcome_index = len(state['outcomes'])
        if definition is not None and definition['execute'] is not None:
            validating = _CallState(request, state['index'], definition)
            state['outcomes'].append(validating)
        if definition is None:
            invalid = ToolValidationError('unknown_tool', f'No tool named "{raw["name"]}" is available.')
        else:
            invalid = None
            try:
                parsed = self._schemas[raw['name']].parse(copy.deepcopy(raw['arguments']))
            except SchemaValidationError as error:
                invalid = ToolValidationError('invalid_arguments', str(error))
        if invalid is not None:
            outcome = {'role': 'tool', 'call_id': raw['id'],
                       'status': invalid.code, 'error': {'message': invalid.message},
                       'created_at': _utc_now()}
            if validating is not None:
                state['outcomes'][outcome_index] = outcome
            else:
                state['outcomes'].append(outcome)
            self._check()
            return ToolValidationErrorEvent(request, state['index'], invalid)
        self._check()
        call = ToolCall(raw['id'], raw['name'], parsed)
        self._calls.append(copy.copy(call))
        call_state = validating or _CallState(call, state['index'], definition)
        call_state.call = call
        if validating is None:
            state['outcomes'].append(call_state)
        if definition['execute'] is not None:
            self._pending.append(call_state)
        return ToolCallEvent(copy.copy(call), state['index'])

    @staticmethod
    def _worker(state, event, completed, model_identity):
        from ._tools import ToolContext, execute_tool, ToolOutputError
        from ._schemas import SchemaResourceError
        _TOOL_THREAD.model_identity = model_identity
        try:
            output = execute_tool(state.definition['definition'], state.call.arguments,
                                  ToolContext(cancel_event=event))
        except (ToolOutputError, SchemaResourceError) as error:
            completed.put((state, 'serialization_error', error, _utc_now()))
            return
        except BaseException as error:
            completed.put((state, 'executor_error', error, _utc_now()))
            return
        completed.put((state, 'output', output, _utc_now()))

    def _pump(self):
        events = []
        limit = (self._options['max_concurrent_tools'] or math.inf) if self._options['tool_execution'] == 'parallel' else 1
        while self._pending and self._running < limit and not self.cancel_event.is_set():
            state = self._pending.popleft()
            state.started = True
            self._running += 1
            worker = threading.Thread(target=self._worker,
                                      args=(state, self.cancel_event, self._completed, self._model._identity), daemon=True,
                                      name=f'wfloat-tool-{state.call.id}')
            worker.start()
            events.append(ToolStartEvent(copy.copy(state.call), state.round_index))
        return events

    def _collect(self):
        while True:
            self._check()
            try:
                state, kind, value, created_at = self._completed.get_nowait()
            except queue.Empty:
                return
            self._running -= 1
            if kind == 'output':
                state.outcome = {'role': 'tool', 'call_id': state.call.id,
                                 'status': 'completed', 'output': value, 'created_at': created_at}
                yield ToolResultEvent(copy.copy(state.call), state.round_index, copy.deepcopy(value))
            else:
                if kind == 'executor_error':
                    state.outcome = {'role': 'tool', 'call_id': state.call.id,
                                     'status': 'failed', 'error': {'message': str(value)},
                                     'created_at': created_at}
                yield ToolErrorEvent(copy.copy(state.call), state.round_index, value)
                if kind == 'serialization_error' or self._options['tool_error_behavior'] == 'stop' or not isinstance(value, Exception):
                    raise value

    def _drain(self):
        while self._pending or self._running:
            self._check()
            yield from self._collect()
            yield from self._pump()
            if self._running:
                self.cancel_event.wait(0.005)

    def _run(self):
        self._started_at = time.monotonic()
        corrections = 0
        try:
            self._check()
            for index in range(self._options['max_rounds']):
                self._check()
                request = self._request(self._partial().new_messages)
                state = {'index': index, 'text': '', 'parts': [], 'outcomes': []}
                self._states.append(state)
                yield RoundStartEvent(index)
                self._check()
                stop, context = 'complete', None
                previous_input = previous_output = 0
                filt = self._filter = _StopFilter(self._options['stop_strings'])
                round_cancel = self._round_cancel = CancellationEvent()
                # Link operation cancellation without modifying the caller's event.
                round_cancel._external = self.cancel_event
                iterator = self._native = iter(self._model._backend.round(request, round_cancel))
                try:
                    while True:
                        self._check()
                        yield from self._collect()
                        if self._options['tool_execution_timing'] == 'immediate':
                            yield from self._pump()
                        self._check()
                        try:
                            event = next(iterator)
                        except StopIteration:
                            break
                        kind = event['type']
                        if kind in ('done', 'usage'):
                            inputs, outputs = event['inputTokens'], event['outputTokens']
                            self._usage.input_tokens += inputs - previous_input
                            self._usage.output_tokens += outputs - previous_output
                            previous_input, previous_output = inputs, outputs
                            if kind == 'done':
                                if stop != 'stop_string':
                                    stop = _SNAKE.get(event['stopReason'], event['stopReason'])
                                raw_context = event.get('contextLimit')
                                if raw_context is not None:
                                    context = ContextLimit(raw_context['phase'], raw_context['capacityTokens'], raw_context['inputTokens'])
                            continue
                        self._check()
                        if stop == 'stop_string':
                            continue
                        if kind == 'text':
                            appended = self._append(state, 'text', filt.push(event['text']))
                            if filt.stopped:
                                stop = 'stop_string'
                                round_cancel.set()
                            if appended:
                                yield appended
                        elif kind in ('reasoning', 'toolCall'):
                            appended = self._append(state, 'text', filt.flush())
                            if appended:
                                yield appended
                            if kind == 'reasoning':
                                appended = self._append(state, 'reasoning', event['text'])
                                if appended:
                                    yield appended
                            else:
                                notification = self._receive(event['call'], state)
                                starts = self._pump() if self._options['tool_execution_timing'] == 'immediate' else []
                                yield notification
                                yield from starts
                        else:
                            raise ValueError(f'Unknown backend event type: {kind}')
                finally:
                    round_cancel.set()
                    try:
                        close = getattr(iterator, 'close', None)
                        if close:
                            close()
                    finally:
                        self._native = None
                        # Retain an incomplete stop prefix even when closing/failing.
                        pending = filt.flush()
                        self._filter = None
                        if pending:
                            self._append(state, 'text', pending)
                if pending:
                    yield TextEvent(pending, index)
                yield from self._drain()
                self._check()
                has_calls = any(p['type'] == 'tool_call' for p in state['parts'])
                manual = any(d['execute'] is None for d in self._options['tools'].values())
                snapshot = self._partial()
                predicate = self._options['stop_when']
                if stop == 'complete' and not (manual and has_calls) and predicate is not None:
                    try:
                        decision = predicate(StopContext(copy.deepcopy(self._input + snapshot.new_messages),
                                                         snapshot.rounds, snapshot.rounds[-1]))
                    except BaseException as error:
                        self._callback_error = error
                        raise
                    if type(decision) is not bool:
                        if inspect.iscoroutine(decision):
                            decision.close()
                        raise TypeError('stop_when must return a boolean')
                    self._check()
                    if decision:
                        stop = 'stop_condition'
                output = None
                if self._output_schema is not None:
                    from ._schemas import SchemaValidationError
                    try:
                        self._validated_text = state['text']
                        self._validated_output = None
                        output = self._output_schema.parse(json.loads(state['text']))
                        self._validated_output = output
                    except (json.JSONDecodeError, SchemaValidationError) as error:
                        self._check()
                        if stop == 'complete':
                            if corrections >= self._options['corrections']:
                                raise
                            if index + 1 >= self._options['max_rounds']:
                                self._finish('max_rounds')
                                return
                            state['outcomes'].append({'role': 'user', 'content':
                                f'The response did not satisfy the output schema: {error}. Return a corrected response.',
                                'created_at': _utc_now()})
                            corrections += 1
                            continue
                self._check()
                if stop != 'complete':
                    self._finish(stop, output, context)
                    return
                if manual and has_calls:
                    self._finish('tool_calls', output)
                    return
                if not has_calls:
                    self._finish('complete', output)
                    return
            self._finish('max_rounds')
        except (_Cancelled, OperationCancelledError) as error:
            if error is self._callback_error:
                raise
            if isinstance(error, OperationCancelledError) and not self.cancel_event.is_set():
                raise GenerationError(str(error), self._partial()) from error
            for state in self._states:
                for item in state['outcomes']:
                    if isinstance(item, _CallState) and item.started and item.outcome is None:
                        yield ToolCancelEvent(copy.copy(item.call), item.round_index)
            self._finish('cancelled')
        except Exception as error:
            self.cancel_event.set()
            if error is self._callback_error:
                raise
            raise GenerationError(str(error), self._partial()) from error
        finally:
            self._model._release(self)


def tool_result(call: Union[ToolCall, dict], output: Any) -> dict:
    """Build a replayable completed manual-tool response, validating JSON output."""
    from ._tools import validate_tool_output
    call_id = call.get('id') if isinstance(call, dict) else call.id
    if not isinstance(call_id, str):
        raise TypeError('Tool call id must be a string')
    output = validate_tool_output(output)
    return {'role': 'tool', 'call_id': call_id, 'status': 'completed',
            'output': output, 'created_at': _utc_now()}

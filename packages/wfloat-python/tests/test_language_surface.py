"""Contract tests using a demand-driven, observable round backend."""
import dataclasses
import inspect
import threading
import time
import warnings

import pytest

from wfloat._language import LanguageModel, tool_result
from wfloat._language_types import GenerationError, GenerationResult, TextEvent, ToolCall
from wfloat._tools import ToolContext, define_tool


class Backend:
    context_size = 512

    def __init__(self, *rounds):
        self.rounds = list(rounds)
        self.requests = []
        self.advances = 0
        self.closed = 0
        self.unloaded = False

    def round(self, request, cancel_event):
        self.requests.append(request)
        source = self.rounds[len(self.requests) - 1]
        iterator = iter(source(request, cancel_event) if callable(source) else source)
        try:
            for event in iterator:
                self.advances += 1
                if isinstance(event, BaseException):
                    raise event
                yield event
        finally:
            self.closed += 1
            close = getattr(iterator, 'close', None)
            if close:
                close()

    def inspect_input(self, request):
        self.inspected = request
        return {'inputTokens': 11, 'capacityTokens': 512, 'fits': True}

    def unload(self):
        self.unloaded = True


def text(value):
    return {'type': 'text', 'text': value}


def done(reason='complete', inputs=4, outputs=2, **extra):
    return {'type': 'done', 'stopReason': reason, 'inputTokens': inputs,
            'outputTokens': outputs, **extra}


def call(id='a', name='f', arguments=None):
    return {'type': 'toolCall', 'call': {'id': id, 'name': name,
                                       'arguments': {} if arguments is None else arguments}}


MESSAGES = [{'role': 'user', 'content': 'hello'}]


def test_stream_lazy_single_pass_callbacks_and_cached_result():
    backend = Backend([text('one'), text(' two'), done()])
    seen = []
    model = LanguageModel(backend)
    stream = model.generate_stream(messages=MESSAGES, on_text=seen.append)
    assert backend.requests == []
    assert next(stream).type == 'round_start'
    assert backend.requests == []
    assert next(stream) == TextEvent('one', 0)
    assert backend.advances == 1
    with stream:
        result = stream.result()
    assert stream.result() is result
    assert list(stream) == []
    assert seen == ['one', ' two']
    assert result.text == 'one two'
    assert dataclasses.is_dataclass(result)
    assert result.usage.output_tokens == 2
    assert backend.closed == 1


def test_input_snapshot_dataclass_roundtrip_and_reasoning_order():
    @dataclasses.dataclass
    class Message:
        role: str
        content: object
    messages = [Message('user', 'original')]
    backend = Backend([{'type': 'reasoning', 'text': 'think'}, text('answer'), done()],
                      [text('next'), done()])
    model = LanguageModel(backend)
    stream = model.generate_stream(messages)
    messages[0].content = 'edited'
    result = stream.result()
    assert backend.requests[0]['messages'][0]['content'] == 'original'
    assert [p['type'] for p in result.new_messages[0]['content']] == ['reasoning', 'text']
    model.generate(result.new_messages)
    assert backend.requests[1]['messages'][0]['content'][0]['text'] == 'think'


def test_manual_calls_validated_no_execution_and_roundtrip():
    schema = {'type': 'object', 'properties': {'n': {'type': 'integer'}}, 'required': ['n']}
    tool = define_tool('f', schema)
    backend = Backend([call(arguments={'n': 3}), done()], [text('ok'), done()])
    model = LanguageModel(backend)
    result = model.generate(MESSAGES, tools=[tool])
    assert result.stop_reason == 'tool_calls'
    assert result.tool_calls == [ToolCall('a', 'f', {'n': 3})]
    assert len(result.new_messages) == 1
    model.generate(result.new_messages + [tool_result(result.tool_calls[0], None)])
    history = backend.requests[1]['messages']
    assert history[0]['content'][0]['type'] == 'toolCall'
    assert history[1] == {'role': 'tool', 'callId': 'a', 'status': 'completed', 'output': None,
                          'createdAt': history[1]['createdAt']}


def test_invalid_and_unknown_calls_feedback_never_actionable():
    tool = define_tool('f', {'type': 'object', 'required': ['n']})
    events = []
    backend = Backend([call('x', 'missing'), call('y'), done()])
    result = LanguageModel(backend).generate(MESSAGES, tools=[tool], on_tool_validation_error=events.append)
    assert result.stop_reason == 'tool_calls'
    assert result.tool_calls == []
    assert [m['status'] for m in result.new_messages[1:]] == ['unknown_tool', 'invalid_arguments']
    assert [e.error.code for e in events] == ['unknown_tool', 'invalid_arguments']


def test_managed_tools_overlap_native_inference_and_history_request_order():
    started = threading.Event()
    second_finished = threading.Event()
    release = threading.Event()
    caller_thread = threading.get_ident()
    callbacks = []
    def execute(args, *, context: ToolContext):
        assert threading.get_ident() != caller_thread
        if args['n'] == 1:
            started.set()
            assert release.wait(2)
        else:
            second_finished.set()
        return args['n']
    tool = define_tool('f', {'type': 'object'}, execute=execute)
    def first(request, event):
        yield call('a', arguments={'n': 1})
        assert started.wait(1), 'Immediate executor must overlap next native step'
        yield call('b', arguments={'n': 2})
        assert second_finished.wait(1)
        release.set()
        yield done(inputs=10, outputs=5)
    backend = Backend(first, [text('final'), done(inputs=20, outputs=3)])
    result = LanguageModel(backend).generate(MESSAGES, tools=[tool], tool_execution='parallel',
        on_tool_result=lambda event: callbacks.append((event.call.id, threading.get_ident())))
    assert result.text == 'final'
    assert result.usage.input_tokens == 30
    assert result.usage.output_tokens == 8
    assert [m['call_id'] for m in result.rounds[0].new_messages[1:]] == ['a', 'b']
    assert all(thread == caller_thread for _, thread in callbacks)
    assert len(callbacks) == 2
    assert backend.requests[1]['messages'][2]['callId'] == 'a'


@pytest.mark.parametrize('timing', ['immediate', 'after_generation'])
def test_timing_and_sequential_cap(timing):
    release = threading.Event()
    first_started = threading.Event()
    second_started = threading.Event()
    def execute(args):
        if args['n'] == 1:
            first_started.set()
            assert release.wait(2)
        else:
            second_started.set()
        return None
    def source(request, event):
        yield call('a', arguments={'n': 1})
        if timing == 'immediate':
            assert first_started.wait(1)
        else:
            assert not first_started.is_set()
        yield call('b', arguments={'n': 2})
        assert not second_started.is_set()
        release.set()
        yield done()
    backend = Backend(source, [done()])
    LanguageModel(backend).generate(MESSAGES, tools=[define_tool('f', {}, execute=execute)],
                                    tool_execution_timing=timing)
    assert second_started.is_set()


def test_break_cancels_daemon_tools_without_waiting_or_late_callbacks():
    entered, release = threading.Event(), threading.Event()
    contexts, workers, notifications = [], [], []
    def execute(args, *, context):
        contexts.append(context)
        workers.append(threading.current_thread())
        entered.set()
        release.wait(3)
        return 'late'
    backend = Backend([call(), text('later'), done()])
    model = LanguageModel(backend)
    external = threading.Event()
    stream = model.generate_stream(MESSAGES, tools=[define_tool('f', {}, execute=execute)],
        cancel_event=external, on_tool_result=notifications.append)
    try:
        with stream:
            for event in stream:
                if event.type == 'tool_call':
                    assert entered.wait(1)
                    break
        result = stream.result()
        assert result.stop_reason == 'cancelled'
        assert result.new_messages[-1]['status'] == 'outcome_unknown'
        assert contexts[0].cancel_event.is_set()
        assert not external.is_set()
        assert workers[0].daemon
        assert workers[0].is_alive()  # close did not join it.
        assert backend.advances == 1
        model.unload()
        assert backend.unloaded
    finally:
        release.set()
    workers[0].join(1)
    assert notifications == []
    assert result.new_messages[-1]['status'] == 'outcome_unknown'


def test_cancel_pending_tools_not_executed_and_result_stable():
    release = threading.Event()
    def execute(args):
        release.wait(3)
        return 1
    backend = Backend([call('a'), call('b'), text('x'), done()])
    stream = LanguageModel(backend).generate_stream(MESSAGES, tools=[define_tool('f', {}, execute=execute)])
    try:
        for event in stream:
            if event.type == 'tool_call' and event.call.id == 'b':
                stream.cancel()
                break
        result = stream.result()
        assert result.stop_reason == 'cancelled'
        assert [m['status'] for m in result.new_messages[1:]] == ['outcome_unknown', 'not_executed']
    finally:
        release.set()
        stream.close()


def test_cancel_before_start_does_not_touch_backend():
    cancel = threading.Event()
    cancel.set()
    backend = Backend()
    result = LanguageModel(backend).generate(MESSAGES, cancel_event=cancel)
    assert result.stop_reason == 'cancelled'
    assert result.rounds == []
    assert backend.requests == []


@pytest.mark.parametrize('notification', ['on_text', 'on_reasoning', 'on_tool_call', 'on_tool_start', 'on_tool_result', 'on_round_start'])
def test_callback_errors_propagate_identity_and_model_can_recover(notification):
    error = LookupError('application')
    def callback(event):
        raise error
    events = [{'type': 'reasoning', 'text': 'why'}, text('hi'), call(), done()]
    backend = Backend(events, [text('recovered'), done()])
    model = LanguageModel(backend)
    stream = model.generate_stream(MESSAGES, tools=[define_tool('f', {}, execute=lambda args: None)],
                                   **{notification: callback})
    with pytest.raises(LookupError) as caught:
        stream.result()
    assert caught.value is error
    with pytest.raises(LookupError) as again:
        stream.result()
    assert again.value is error
    # A round-start callback fails before the backend is entered.
    if notification == 'on_round_start':
        backend.rounds[0] = [text('recovered'), done()]
    assert model.generate(MESSAGES).text == 'recovered'


def test_native_failure_partial_reasoning_text_and_cause():
    error = RuntimeError('native error')
    backend = Backend([text('partial ST'), error])
    with pytest.raises(GenerationError) as caught:
        LanguageModel(backend).generate(MESSAGES, stop_strings=['STOP'])
    assert caught.value.__cause__ is error
    assert caught.value.partial_result.text == 'partial ST'
    assert backend.closed == 1


@pytest.mark.parametrize('stop', ['maxTokens', 'contextLimit'])
def test_expected_stops_do_not_retry_invalid_structured_output(stop):
    backend = Backend([text('{'), done(stop)])
    result = LanguageModel(backend).generate(MESSAGES,
        structured_output={'schema': {'type': 'object'}, 'max_correction_attempts': 3})
    assert result.stop_reason in ('max_tokens', 'context_limit')
    assert result.output is None
    assert len(backend.requests) == 1


def test_structured_corrections_are_visible_and_count_against_round_budget():
    backend = Backend([text('no'), done()], [text('{"n":3}'), done()])
    result = LanguageModel(backend).generate(MESSAGES, structured_output={
        'schema': {'type': 'object'}, 'max_correction_attempts': 1})
    assert result.output == {'n': 3}
    assert result.text == '{"n":3}'
    assert result.rounds[0].text == 'no'
    assert result.new_messages[1]['role'] == 'user'
    assert backend.requests[1]['messages'][2]['content'].startswith('The response did not satisfy')
    backend = Backend([text('no'), done()])
    with pytest.warns(RuntimeWarning, match='max_rounds limits'):
        result = LanguageModel(backend).generate(MESSAGES, max_rounds=1,
            structured_output={'schema': {}, 'max_correction_attempts': 2})
    assert result.stop_reason == 'max_rounds'


def test_default_zero_correction_and_empty_schema_and_null():
    with pytest.raises(GenerationError) as caught:
        LanguageModel(Backend([text('no'), done()])).generate(MESSAGES, structured_output={'schema': {}})
    assert caught.value.__cause__ is not None
    result = LanguageModel(Backend([text('null'), done()])).generate(MESSAGES,
        structured_output={'schema': {'type': 'null'}})
    assert result.stop_reason == 'complete'
    assert result.output is None
    assert not hasattr(result, 'has_output')


def test_stop_strings_cross_tokens_only_filter_text_and_flush_at_reasoning():
    def source(request, event):
        yield text('hello ST')
        yield text('OP hidden')
        assert event.is_set()
        yield {'type': 'reasoning', 'text': 'ignored after stop'}
        yield done(outputs=9)
    backend = Backend(source)
    result = LanguageModel(backend).generate(MESSAGES, stop_strings=['STOP'])
    assert result.text == 'hello '
    assert result.stop_reason == 'stop_string'
    assert result.usage.output_tokens == 9
    backend = Backend([text('ST'), {'type': 'reasoning', 'text': 'STOP'}, text('OP'), done()])
    result = LanguageModel(backend).generate(MESSAGES, stop_strings=['STOP'])
    assert result.stop_reason == 'complete'
    assert result.text == 'STOP'
    assert result.new_messages[0]['content'][1] == {'type': 'reasoning', 'text': 'STOP'}


def test_usage_snapshots_not_double_counted_and_context_detail():
    backend = Backend([{'type': 'usage', 'inputTokens': 8, 'outputTokens': 1},
                       done('contextLimit', inputs=8, outputs=3,
                            contextLimit={'phase': 'generation', 'capacityTokens': 12, 'inputTokens': 8})])
    result = LanguageModel(backend).generate(MESSAGES)
    assert result.usage.input_tokens == 8
    assert result.usage.output_tokens == 3
    assert result.context_limit.capacity_tokens == 12


def test_tool_errors_continue_but_bad_output_always_fails():
    def execute(args):
        raise OSError('network')
    tool = define_tool('f', {}, execute=execute)
    result = LanguageModel(Backend([call(), done()], [text('fallback'), done()])).generate(MESSAGES, tools=[tool])
    assert result.text == 'fallback'
    assert result.rounds[0].new_messages[-1]['status'] == 'failed'
    with pytest.raises(GenerationError) as caught:
        LanguageModel(Backend([call(), done()])).generate(MESSAGES, tools=[tool], tool_error_behavior='stop')
    assert isinstance(caught.value.__cause__, OSError)
    with pytest.raises(GenerationError) as caught:
        LanguageModel(Backend([call(), done()])).generate(MESSAGES,
            tools=[define_tool('f', {}, execute=lambda args: object())])
    assert isinstance(caught.value.__cause__, TypeError)
    assert caught.value.partial_result.new_messages[-1]['status'] == 'outcome_unknown'


def test_max_rounds_defaults_twenty_and_stop_when_after_tool_results():
    backend = Backend(*[[call(str(i)), done()] for i in range(20)])
    result = LanguageModel(backend).generate(MESSAGES, tools=[define_tool('f', {}, execute=lambda args: None)])
    assert result.stop_reason == 'max_rounds'
    assert len(result.rounds) == 20
    seen = []
    def stop(context):
        seen.append(context)
        return True
    result = LanguageModel(Backend([call(), done()])).generate(MESSAGES,
        tools=[define_tool('f', {}, execute=lambda args: None)], stop_when=stop)
    assert result.stop_reason == 'stop_condition'
    assert seen[0].messages[-1]['status'] == 'completed'


def test_stop_predicate_error_is_unchanged():
    error = RuntimeError('predicate')
    def stop(context):
        raise error
    with pytest.raises(RuntimeError) as caught:
        LanguageModel(Backend([done()])).generate(MESSAGES, stop_when=stop)
    assert caught.value is error


def test_duplicate_tool_ids_are_runtime_failure():
    with pytest.raises(GenerationError, match='repeated tool invocation'):
        LanguageModel(Backend([call(), call(), done()])).generate(MESSAGES, tools=[define_tool('f', {})])


@pytest.mark.parametrize('options', [
    {'max_rounds': 0}, {'max_rounds': None}, {'max_tokens_per_round': True},
    {'max_concurrent_tools': 2}, {'tool_execution': 'mixed'}, {'reasoning': 1},
    {'stop_strings': 'stop'}, {'stop_strings': ['']}, {'temperature': float('nan')},
    {'top_p': 2}, {'top_k': -1}, {'seed': 2**32}, {'on_text': 1},
    {'structured_output': {'schema': {}, 'max_correction_attempts': -1}},
    {'tools': [define_tool('f', {}), define_tool('g', {}, execute=lambda args: None)]},
    {'tools': [define_tool('f', {})], 'structured_output': {'schema': {}}},
])
def test_invalid_options_eager_before_inference(options):
    backend = Backend()
    with pytest.raises((TypeError, ValueError)):
        LanguageModel(backend).generate_stream(MESSAGES, **options)
    assert backend.requests == []


def test_options_keyword_only_and_inspection_uses_actual_schemas():
    for name in ('generate', 'generate_stream', 'count_input_tokens'):
        sig = inspect.signature(getattr(LanguageModel, name))
        assert sig.parameters['messages'].kind == inspect.Parameter.POSITIONAL_OR_KEYWORD
        assert all(p.kind == inspect.Parameter.KEYWORD_ONLY for n, p in sig.parameters.items()
                   if n not in ('self', 'messages'))
    backend = Backend()
    model = LanguageModel(backend)
    assert model.count_input_tokens(MESSAGES, structured_output={'schema': {}}) == 11
    assert backend.inspected['structuredOutput'] == {}
    assert backend.requests == []


def test_reentrant_stream_and_shared_model_guards_do_not_deadlock():
    backend = Backend([text('hello'), done()], [done()])
    model = LanguageModel(backend)
    stream = model.generate_stream(MESSAGES)
    next(stream)
    with pytest.raises(RuntimeError, match='active operation'):
        model.generate(MESSAGES)
    stream.close()
    # No native round ran: first request still available.
    assert model.generate(MESSAGES).text == 'hello'
    stream = model.generate_stream(MESSAGES, on_round_start=lambda event: stream.result())
    with pytest.raises(RuntimeError, match='reentrant'):
        stream.result()


def test_unload_cancels_unstarted_stream_and_result_remains_available():
    backend = Backend()
    model = LanguageModel(backend)
    stream = model.generate_stream(MESSAGES)
    model.unload()
    assert stream.result().stop_reason == 'cancelled'
    assert backend.unloaded
    with pytest.raises(RuntimeError, match='unloaded'):
        model.generate(MESSAGES)


def test_pydantic_transform_preserves_raw_arguments_in_history():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    class Input(BaseModel):
        word: str
        @field_validator('word')
        @classmethod
        def uppercase(cls, value):
            return value.upper()
    seen = []
    tool = define_tool('f', Input, execute=lambda args: seen.append(args.word))
    backend = Backend([call(arguments={'word': 'raw'}), done()], [done()])
    result = LanguageModel(backend).generate(MESSAGES, tools=[tool])
    assert seen == ['RAW']
    assert result.tool_calls[0].arguments.word == 'RAW'
    assert result.new_messages[0]['content'][0]['arguments'] == {'word': 'raw'}


def test_fifo_threads_queue_in_arrival_order_and_waiting_cancellation():
    backend = Backend([text('first'), done()], [text('second'), done()])
    model = LanguageModel(backend)
    first = model.generate_stream([{'role': 'user', 'content': 'first'}])
    next(first)
    outcomes, failures = {}, []
    cancel = threading.Event()
    def run(name, event=None):
        try:
            outcomes[name] = model.generate([{'role': 'user', 'content': name}], cancel_event=event)
        except BaseException as error:
            failures.append(error)
    cancelled = threading.Thread(target=run, args=('cancelled', cancel), daemon=True)
    second = threading.Thread(target=run, args=('second',), daemon=True)
    cancelled.start()
    deadline = time.monotonic() + 2
    while len(model._waiting) != 1 and time.monotonic() < deadline:
        time.sleep(.001)
    second.start()
    while len(model._waiting) != 2 and time.monotonic() < deadline:
        time.sleep(.001)
    assert len(model._waiting) == 2
    cancel.set()
    cancelled.join(1)
    assert not cancelled.is_alive()
    assert outcomes['cancelled'].stop_reason == 'cancelled'
    assert backend.requests == []
    assert first.result().text == 'first'
    second.join(1)
    assert not second.is_alive()
    assert failures == []
    assert outcomes['second'].text == 'second'
    assert [r['messages'][0]['content'] for r in backend.requests] == ['first', 'second']


def test_unload_during_native_next_waits_for_safe_cleanup_and_releases_lease_once():
    entered, released, cleanup = threading.Event(), threading.Event(), threading.Event()
    def source(request, event):
        try:
            entered.set()
            assert event.wait(2)
            assert released.wait(2)
            yield text('not delivered after close')
        finally:
            cleanup.set()
    class Lease:
        count = 0
        def release(self):
            assert cleanup.is_set()
            assert backend.unloaded
            self.count += 1
    backend = Backend(source)
    lease = Lease()
    model = LanguageModel(backend, asset_lease=lease)
    stream = model.generate_stream(MESSAGES)
    results = []
    runner = threading.Thread(target=lambda: results.append(stream.result()), daemon=True)
    runner.start()
    assert entered.wait(1)
    unloader = threading.Thread(target=model.unload, daemon=True)
    unloader.start()
    assert stream.cancel_event.wait(1)
    assert unloader.is_alive()
    assert not backend.unloaded
    released.set()
    runner.join(1)
    unloader.join(1)
    assert not runner.is_alive() and not unloader.is_alive()
    assert results[0].stop_reason == 'cancelled'
    assert lease.count == 1
    model.unload()
    assert lease.count == 1


def test_native_unload_failure_retains_lease_for_safe_retry():
    class Lease:
        count = 0
        def release(self):
            self.count += 1
    class FailingBackend(Backend):
        attempts = 0
        def unload(self):
            self.attempts += 1
            if self.attempts == 1:
                raise RuntimeError('still using resources')
            super().unload()
    backend, lease = FailingBackend(), Lease()
    model = LanguageModel(backend, asset_lease=lease)
    with pytest.raises(RuntimeError):
        model.unload()
    assert lease.count == 0
    model.unload()
    assert lease.count == 1


def test_transform_programming_error_leaves_managed_not_executed():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    error = TypeError('validator bug')
    class Input(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def invalid(cls, value):
            raise error
    executions, invalid = [], []
    backend = Backend([call(arguments={'x': 1}), done()])
    with pytest.raises(GenerationError) as caught:
        LanguageModel(backend).generate(MESSAGES,
            tools=[define_tool('f', Input, execute=lambda args: executions.append(args))],
            on_tool_validation_error=invalid.append)
    assert caught.value.__cause__ is error
    assert caught.value.partial_result.new_messages[-1]['status'] == 'not_executed'
    assert not executions and not invalid


def test_noncopyable_transform_identity_preserved():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    lock = threading.Lock()
    seen, calls = [], []
    class Input(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def transform(cls, value):
            return lock
    backend = Backend([call(arguments={'x': 1}), done()], [done()])
    result = LanguageModel(backend).generate(MESSAGES,
        tools=[define_tool('f', Input, execute=lambda args: seen.append(args.x))],
        on_tool_call=calls.append)
    assert seen[0] is lock
    assert calls[0].call.arguments.x is lock
    assert result.tool_calls[0].arguments.x is lock
    assert result.new_messages[0]['content'][0]['arguments'] == {'x': 1}


def test_schema_cancellation_does_not_promote_tool_call():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    cancel = threading.Event()
    class Input(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def stop(cls, value):
            cancel.set()
            return value
    calls, executed = [], []
    result = LanguageModel(Backend([call(arguments={'x': 1}), done()])).generate(MESSAGES,
        tools=[define_tool('f', Input, execute=lambda args: executed.append(args))],
        cancel_event=cancel, on_tool_call=calls.append)
    assert result.stop_reason == 'cancelled'
    assert result.tool_calls == [] and calls == [] and executed == []
    assert result.new_messages[-1]['status'] == 'not_executed'


def test_structured_cancellation_keeps_validated_output_without_retransforming():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    cancel = threading.Event()
    parsed = []
    class Output(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def stop(cls, value):
            parsed.append(value)
            cancel.set()
            return value
    result = LanguageModel(Backend([text('{"x":3}'), done()])).generate(MESSAGES,
        structured_output={'schema': Output}, cancel_event=cancel)
    assert result.stop_reason == 'cancelled'
    assert result.output.x == 3
    assert parsed == [3]


def test_cancellation_validates_complete_available_text_without_new_inference():
    cancel = threading.Event()
    backend = Backend([text('{"x":3}'), text('not reached'), done()])
    stream = LanguageModel(backend).generate_stream(MESSAGES,
        structured_output={'schema': {'type': 'object'}}, cancel_event=cancel)
    next(stream)
    next(stream)
    cancel.set()
    result = stream.result()
    assert result.stop_reason == 'cancelled'
    assert result.output == {'x': 3}
    assert backend.advances == 1


@pytest.mark.parametrize('set_cancel', [False, True])
def test_stop_predicate_cancellation_exception_is_original(set_cancel):
    from wfloat._operations import OperationCancelledError
    error = OperationCancelledError('callback sentinel')
    cancel = threading.Event()
    def stop(context):
        if set_cancel:
            cancel.set()
        raise error
    with pytest.raises(OperationCancelledError) as caught:
        LanguageModel(Backend([done()])).generate(MESSAGES, stop_when=stop, cancel_event=cancel)
    assert caught.value is error


def test_parallel_cap_and_paused_iteration_do_not_schedule_queued_work():
    release = threading.Event()
    started = [threading.Event() for _ in range(3)]
    def execute(args):
        started[args['n']].set()
        assert release.wait(2)
        return args['n']
    backend = Backend([call(str(i), arguments={'n': i}) for i in range(3)] + [done()], [done()])
    stream = LanguageModel(backend).generate_stream(MESSAGES,
        tools=[define_tool('f', {}, execute=execute)], tool_execution='parallel', max_concurrent_tools=2)
    try:
        for event in stream:
            if event.type == 'tool_call' and event.call.id == '2':
                break
        assert started[0].wait(1) and started[1].wait(1)
        assert not started[2].is_set()
        release.set()
        # Completion of already-running tools must not itself schedule new work.
        assert not started[2].wait(.03)
        result = stream.result()
        assert started[2].is_set()
        assert result.stop_reason == 'complete'
    finally:
        release.set()
        stream.close()


def test_cancellation_schema_transform_cannot_hold_close_indefinitely():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    entered, release = threading.Event(), threading.Event()
    class Output(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def block(cls, value):
            entered.set()
            release.wait(3)
            return value
    stream = LanguageModel(Backend([text('{"x":3}'), done()])).generate_stream(MESSAGES,
        structured_output={'schema': Output})
    next(stream)
    next(stream)
    try:
        start = time.monotonic()
        stream.close()
        assert time.monotonic() - start < .8
        assert entered.is_set()
        result = stream.result()
        assert result.stop_reason == 'cancelled' and result.output is None
    finally:
        release.set()
    assert stream.result() is result and result.output is None


def test_keyboard_interrupt_and_cleanup_failure_do_not_replace_callback_error():
    error = KeyboardInterrupt()
    def source(request, event):
        try:
            yield text('x')
        finally:
            raise RuntimeError('cleanup failure')
    def callback(value):
        raise error
    stream = LanguageModel(Backend(source)).generate_stream(MESSAGES, on_text=callback)
    with pytest.raises(KeyboardInterrupt) as caught:
        stream.result()
    assert caught.value is error
    with pytest.raises(KeyboardInterrupt) as again:
        stream.result()
    assert again.value is error


def test_callback_self_unload_rejected_without_poisoning_model():
    backend = Backend([text('x'), done()], [text('recovered'), done()])
    model = LanguageModel(backend)
    with pytest.raises(RuntimeError, match='active callback'):
        model.generate(MESSAGES, on_text=lambda text: model.unload())
    assert not backend.unloaded
    assert model.generate(MESSAGES).text == 'recovered'


def test_three_threads_finish_fifo_even_when_created_in_reverse_order():
    backend = Backend([done()], [done()], [done()])
    model = LanguageModel(backend)
    gate = model.generate_stream([{'role': 'user', 'content': 'gate'}])
    next(gate)
    later = model.generate_stream([{'role': 'user', 'content': 'later'}])
    earlier = model.generate_stream([{'role': 'user', 'content': 'earlier'}])
    workers = []
    for i, stream in enumerate([earlier, later], 1):
        worker = threading.Thread(target=stream.result, daemon=True)
        workers.append(worker)
        worker.start()
        deadline = time.monotonic() + 2
        while len(model._waiting) != i and time.monotonic() < deadline:
            time.sleep(.001)
        assert len(model._waiting) == i
    gate.result()
    for worker in workers:
        worker.join(1)
        assert not worker.is_alive()
    assert [r['messages'][0]['content'] for r in backend.requests] == ['gate', 'earlier', 'later']


def test_managed_executor_same_model_reentrancy_rejects_without_queued_inference():
    backend = Backend([call(), done()])
    model = LanguageModel(backend)
    tool = define_tool('f', {}, execute=lambda args: model.generate(MESSAGES).text)
    errors = []
    def run():
        try:
            model.generate(MESSAGES, tools=[tool], tool_error_behavior='stop')
        except BaseException as error:
            errors.append(error)
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(1)
    assert not worker.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], GenerationError)
    assert isinstance(errors[0].__cause__, RuntimeError)
    assert 'own active model' in str(errors[0].__cause__)
    assert len(backend.requests) == 1
    assert not model._waiting


def test_cancelled_failed_transform_runs_once():
    pydantic = pytest.importorskip('pydantic', minversion='2')
    BaseModel, field_validator = pydantic.BaseModel, pydantic.field_validator
    cancel = threading.Event()
    parsed = []
    class Output(BaseModel):
        x: int
        @field_validator('x')
        @classmethod
        def stop(cls, value):
            parsed.append(value)
            cancel.set()
            raise ValueError('invalid')
    result = LanguageModel(Backend([text('{"x":3}'), done()])).generate(MESSAGES,
        structured_output={'schema': Output}, cancel_event=cancel)
    assert result.stop_reason == 'cancelled'
    assert result.output is None
    assert parsed == [3]


def test_count_claim_shutdown_race_does_not_inspect_unloaded_native():
    claimed, release = threading.Event(), threading.Event()
    class CheckingBackend(Backend):
        def inspect_input(self, request):
            assert not self.unloaded
            return super().inspect_input(request)
    backend = CheckingBackend()
    model = LanguageModel(backend)
    original_claim = model._claim
    def claim(operation):
        result = original_claim(operation)
        claimed.set()
        assert release.wait(2)
        return result
    model._claim = claim
    errors = []
    def count():
        try:
            model.count_input_tokens(MESSAGES)
        except BaseException as error:
            errors.append(error)
    counter = threading.Thread(target=count, daemon=True)
    counter.start()
    assert claimed.wait(1)
    unloader = threading.Thread(target=model.unload, daemon=True)
    unloader.start()
    deadline = time.monotonic() + 1
    while not model._closed and time.monotonic() < deadline:
        time.sleep(.001)
    assert model._closed and not backend.unloaded
    release.set()
    counter.join(1)
    unloader.join(1)
    assert not counter.is_alive() and not unloader.is_alive()
    assert errors == []
    assert backend.unloaded


def test_stop_predicate_stop_iteration_original_available_from_result():
    error = StopIteration('application sentinel')
    def stop(context):
        raise error
    stream = LanguageModel(Backend([done()])).generate_stream(MESSAGES, stop_when=stop)
    with pytest.raises(StopIteration) as caught:
        stream.result()
    assert caught.value is error
    with pytest.raises(StopIteration) as again:
        stream.result()
    assert again.value is error


def test_model_context_cleanup_failure_preserves_application_error():
    error = RuntimeError('callback')
    class BrokenUnload(Backend):
        def unload(self):
            raise OSError('cleanup failed')
    def callback(text):
        raise error
    with pytest.raises(RuntimeError) as caught:
        with LanguageModel(BrokenUnload([text('hi'), done()])) as model:
            model.generate(MESSAGES, on_text=callback)
    assert caught.value is error


@pytest.mark.parametrize('method', ['generate', 'generate_stream'])
@pytest.mark.parametrize('max_rounds,attempts,expected', [
    (2, 5, True), (3, 2, False), (5, 2, False), (1, 0, False),
    (20, 20, True), (None, 20, False), (1, None, False),
])
def test_budget_warning_only_for_explicit_truncated_pair(method, max_rounds, attempts, expected):
    backend = Backend([text('null'), done()])
    model = LanguageModel(backend)
    options = {'structured_output': {'schema': {}}}
    if max_rounds is not None:
        options['max_rounds'] = max_rounds
    if attempts is not None:
        options['structured_output']['max_correction_attempts'] = attempts
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        operation = getattr(model, method)(MESSAGES, **options)
    matching = [w for w in caught if 'max_rounds limits' in str(w.message)]
    assert len(matching) == int(expected)
    if method == 'generate_stream':
        assert backend.requests == []  # Configuration warning precedes inference.
        operation.close()


def test_count_input_tokens_does_not_warn_about_omitted_round_budget():
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        LanguageModel(Backend()).count_input_tokens(MESSAGES,
            structured_output={'schema': {}, 'max_correction_attempts': 30})
    assert caught == []


def test_public_return_annotations_preserved_by_option_tracking():
    from typing import get_type_hints
    from wfloat._language import LanguageStream
    assert get_type_hints(LanguageModel.generate)['return'] is GenerationResult
    assert get_type_hints(LanguageModel.generate_stream)['return'] is LanguageStream
    assert inspect.signature(LanguageModel.generate).parameters['max_rounds'].default == 20
    with pytest.raises(TypeError):
        LanguageModel(Backend()).generate(MESSAGES, 5)


@pytest.mark.parametrize('first', [text('first'), {'type': 'reasoning', 'text': 'think'}, call()])
def test_assistant_timestamp_is_first_content_not_enqueue_or_snapshot(monkeypatch, first):
    import wfloat._language as language
    clock = {'now': '2026-10-04T10:00:00.001Z'}
    monkeypatch.setattr(language, '_utc_now', lambda: clock['now'])
    backend = Backend([first, text('later'), done()])
    stream = LanguageModel(backend).generate_stream(MESSAGES, tools=[define_tool('f', {})])
    next(stream)  # Round start is not assistant creation.
    clock['now'] = '2026-10-04T10:00:01.002Z'
    next(stream)
    first_snapshot = stream._partial()
    clock['now'] = '2026-10-04T10:00:02.003Z'
    result = stream.result()
    assert first_snapshot.new_messages[0]['created_at'] == '2026-10-04T10:00:01.002Z'
    assert result.new_messages[0]['created_at'] == first_snapshot.new_messages[0]['created_at']
    assert result.rounds[0].new_messages[0]['created_at'] == first_snapshot.new_messages[0]['created_at']
    assert set(dataclasses.asdict(result.rounds[0])) == {'round_index', 'text', 'new_messages'}


@pytest.mark.parametrize('failed', [False, True])
def test_managed_outcome_timestamp_precedes_delayed_collection(monkeypatch, failed):
    import wfloat._language as language
    release, recorded = threading.Event(), threading.Event()
    clock = {'now': '2026-10-04T10:00:00.001Z'}
    def timestamp():
        stamp = clock['now']
        if threading.current_thread().name.startswith('wfloat-tool-'):
            recorded.set()
        return stamp
    monkeypatch.setattr(language, '_utc_now', timestamp)
    def execute(args):
        assert release.wait(2)
        if failed:
            raise OSError('failed outcome')
        return None
    backend = Backend([call(), done()], [done()])
    stream = LanguageModel(backend).generate_stream(MESSAGES,
        tools=[define_tool('f', {}, execute=execute)])
    try:
        for event in stream:
            if event.type == 'tool_call':
                break
        clock['now'] = '2026-10-04T10:00:01.002Z'
        release.set()
        assert recorded.wait(1)
        clock['now'] = '2026-10-04T10:00:09.009Z'
        result = stream.result()
        outcome = result.rounds[0].new_messages[-1]
        assert outcome['status'] == ('failed' if failed else 'completed')
        assert outcome['created_at'] == '2026-10-04T10:00:01.002Z'
        assert backend.requests[1]['messages'][-1]['createdAt'] == outcome['created_at']
    finally:
        release.set()
        stream.close()


def test_timestamped_cancel_records_are_stable_and_do_not_claim_completion(monkeypatch):
    import wfloat._language as language
    release = threading.Event()
    clock = {'now': '2026-10-04T10:00:00.001Z'}
    monkeypatch.setattr(language, '_utc_now', lambda: clock['now'])
    def execute(args):
        release.wait(2)
        return 7
    stream = LanguageModel(Backend([call('a'), call('b'), done()])).generate_stream(MESSAGES,
        tools=[define_tool('f', {}, execute=execute)])
    try:
        for event in stream:
            if event.type == 'tool_call' and event.call.id == 'b':
                break
        clock['now'] = '2026-10-04T10:00:01.002Z'
        stream.close()
        result = stream.result()
        assert [m['status'] for m in result.new_messages[1:]] == ['outcome_unknown', 'not_executed']
        assert all(m['created_at'] == '2026-10-04T10:00:01.002Z' for m in result.new_messages[1:])
        clock['now'] = '2026-10-04T10:00:09.009Z'
        release.set()
        assert stream._partial().new_messages == result.new_messages
        assert all('output' not in m for m in result.new_messages[1:])
    finally:
        release.set()
        stream.close()


def test_error_and_validation_feedback_timestamps(monkeypatch):
    import wfloat._language as language
    stamp = '2026-10-04T10:00:00.001Z'
    monkeypatch.setattr(language, '_utc_now', lambda: stamp)
    with pytest.raises(GenerationError) as caught:
        LanguageModel(Backend([text('partial'), RuntimeError('native')])).generate(MESSAGES)
    assert caught.value.partial_result.new_messages[0]['created_at'] == stamp
    tool = define_tool('f', {'type': 'object', 'required': ['x']})
    result = LanguageModel(Backend([call('a'), call('b', 'missing'), done()])).generate(MESSAGES, tools=[tool])
    assert [m['status'] for m in result.new_messages[1:]] == ['invalid_arguments', 'unknown_tool']
    assert all(m['created_at'] == stamp for m in result.new_messages)


def test_correction_feedback_timestamp_fixed_at_creation(monkeypatch):
    import wfloat._language as language
    clock = {'now': '2026-10-04T10:00:00.001Z'}
    monkeypatch.setattr(language, '_utc_now', lambda: clock['now'])
    def source(request, event):
        yield text('invalid')
        clock['now'] = '2026-10-04T10:00:01.002Z'
        yield done()
    def second(request, event):
        clock['now'] = '2026-10-04T10:00:02.003Z'
        yield text('null')
        yield done()
    result = LanguageModel(Backend(source, second)).generate(MESSAGES,
        structured_output={'schema': {}, 'max_correction_attempts': 1})
    assert [m['created_at'] for m in result.new_messages] == [
        '2026-10-04T10:00:00.001Z', '2026-10-04T10:00:01.002Z', '2026-10-04T10:00:02.003Z']
    assert result.new_messages[1]['role'] == 'user'


def test_manual_timestamp_format_and_caller_timestamp_preservation():
    import re
    output = tool_result(ToolCall('a', 'f', {}), None)
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', output['created_at'])
    caller_time = '2020-01-02T03:04:05.006Z'
    messages = [{'role': 'user', 'content': 'untimestamped'},
                {'role': 'assistant', 'content': 'saved', 'created_at': caller_time}, output]
    backend = Backend([text('new'), done()])
    result = LanguageModel(backend).generate(messages)
    assert 'createdAt' not in backend.requests[0]['messages'][0]
    assert backend.requests[0]['messages'][1]['createdAt'] == caller_time
    assert backend.requests[0]['messages'][2]['createdAt'] == output['created_at']
    assert 'created_at' not in messages[0]
    assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', result.new_messages[0]['created_at'])

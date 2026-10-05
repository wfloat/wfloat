# Language model

```python
from wfloat import load_language_model

messages = [{"role": "user", "content": "Hello!"}]
with load_language_model("HuggingFaceTB/SmolLM2-360M-Instruct") as model:
    result = model.generate(messages, max_tokens_per_round=128)
    print(result.text, result.stop_reason)
    messages.extend(result.new_messages)
```

## `generate()` and `generate_stream()`

`generate(messages, **options)` blocks and returns a `GenerationResult`. Input history is not mutated. `generate_stream()` returns a lazy, single-pass context-managed iterator:

```python
# With the model still loaded:
with model.generate_stream(messages) as stream:
    for event in stream:
        if event.type == "text":
            print(event.text, end="", flush=True)
    result = stream.result()
```

`stream.result()` drives any remaining work and returns the cached result. `stream.cancel()` stops cooperatively; exiting the context cleans up. Blocking calls accept a `threading.Event` as `cancel_event`. Cancellation returns partial work with `stop_reason="cancelled"`; failures raise `GenerationError` with `partial_result` and `__cause__`.

The result includes latest-round `text`, appendable `new_messages`, `rounds`, `usage.input_tokens`, `usage.output_tokens`, and `duration_ms`. Check `stop_reason`: `complete`, `tool_calls`, `max_rounds`, `stop_condition`, `max_tokens`, `cancelled`, `context_limit`, or `stop_string`. Latest-round text is not guaranteed to be a final answer.

Options include `max_rounds` (default 20), `max_tokens_per_round`, `reasoning`, `stop_strings`, and `stop_when`. Sampling overrides: `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `seed`. Omitted sampling settings use model/runtime defaults. Reasoning counts toward the per-round token cap; stop strings apply to answer text and are removed from output.

`on_text` and `on_reasoning` are alternatives to reading those stream events. `on_round_start` identifies each round. Callbacks run inline; keep them short. Their exceptions propagate after cleanup.

## `define_tool()`

```python
from wfloat import define_tool
from datetime import datetime, timezone

clock = define_tool(
    "clock",
    {"type": "object", "properties": {}, "additionalProperties": False},
    description="Read the current time.",
    execute=lambda args: {"time": datetime.now(timezone.utc).isoformat()},
)
result = model.generate(messages, tools=[clock])
```

All tools must provide executors or all must be manual. Executors receive validated arguments and return JSON-compatible values. An optional keyword-only `context` parameter receives `ToolContext.cancel_event`. Executors may run on background threads; async executors are unsupported.

Defaults: `tool_execution="sequential"`, `tool_execution_timing="immediate"`, `tool_error_behavior="continue"`. Alternatives are `"parallel"` with optional `max_concurrent_tools`, `"after_generation"`, and `"stop"`, respectively. Executors are not automatically retried.

Notifications: `on_tool_call`, `on_tool_start`, `on_tool_result`, `on_tool_error`, `on_tool_cancel`, `on_tool_validation_error`. For manual handling, omit `execute`, append `result.new_messages`, execute `result.tool_calls`, and append `tool_result(call, output)` messages before generating again. Do not execute twice if you already handled an early notification.

```python
from wfloat import tool_result

manual_clock = define_tool("clock", clock.json_schema)
turn = model.generate(messages, tools=[manual_clock])
messages.extend(turn.new_messages)
for call in turn.tool_calls:
    messages.append(tool_result(call, {"time": datetime.now(timezone.utc).isoformat()}))
# Pass the updated messages to the next generate() call.
```

## `structured_output`

```python
from wfloat import StructuredOutput

result = model.generate(messages, structured_output=StructuredOutput(
    schema={"type": "object", "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"], "additionalProperties": False},
    max_correction_attempts=0,
))
print(result.output)
```

Tools and structured output accept supported JSON Schema. The optional `wfloat[schemas]` extra also accepts Pydantic models and dataclasses, returning validated instances. Additional validators run after constrained decoding. Tools cannot be combined with structured output.

Correction attempts default to zero and consume the round budget. Exhausted validation raises; an expected early stop may return no validated output. `output=None` can represent either JSON null or absent output; inspect `stop_reason`.

## Context and ownership

`load_language_model(..., context_size=2048)` sets capacity. `model.context_size` exposes it; `model.count_input_tokens(messages, ...)` counts the request, including matching tool/schema/reasoning options. Context-limit stops provide `context_limit`; Wfloat does not compact history automatically.

Same-model operations on different threads queue. Finish/close a stream before starting another operation on its driving thread. A managed executor cannot synchronously generate on its own active model.

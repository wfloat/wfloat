# Wfloat for Python

Run language, speech synthesis, speech recognition and voice activity models locally.
The Python surface is synchronous: ordinary calls return results, streams use `for`,
and live recognition sessions accept application-supplied audio. Wfloat does not open
microphones or play sound in this release.

## Installation

```sh
pip install wfloat
# Optional: Pydantic models and dataclasses as tool/output schemas.
pip install 'wfloat[schemas]'
```

NumPy provides the audio array representation. Pydantic is optional; plain JSON
Schema does not require it. Native model runtimes are bundled in platform wheels.
A source checkout requires a native build; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Language generation

```python
from wfloat import load_language_model

messages = [{"role": "user", "content": "Explain tides briefly."}]
with load_language_model("HuggingFaceTB/SmolLM2-360M-Instruct") as model:
    result = model.generate(messages, max_tokens_per_round=256)
    print(result.text)
    print(result.stop_reason, result.usage.output_tokens)
    messages.extend(result.new_messages)
```

The main input can be positional or named. Configuration arguments are keyword-only.
`unload()` releases a model explicitly; the model context manager does the same on
exit. Unloading does not delete downloaded model files.

### Streaming

```python
with load_language_model("HuggingFaceTB/SmolLM2-360M-Instruct") as model:
    with model.generate_stream(messages) as stream:
        for event in stream:
            if event.type == "text":
                print(event.text, end="", flush=True)
        result = stream.result()
```

Streams are lazy and single-pass. Requesting the next event advances inference;
`result()` drives any remaining work and returns the cached completed LLM result.
Reasoning, round boundaries and tool activity are separate typed events. A round's
text can be intermediate commentary; `result.text` is the latest round's text, not
all rounds concatenated or a guarantee of a finished answer. Check `stop_reason`.
Generated history messages have ISO 8601 UTC `created_at` strings. Result
`duration_ms` measures the operation after it begins, including managed tool waits.
Same-model operations from different threads queue in FIFO order. Close or finish
a stream before starting another operation on its driving thread. An executor
must not call its own active model synchronously.

Callbacks run inline on the thread driving the operation. Keep them short; their
exceptions propagate unchanged after cleanup. `KeyboardInterrupt` also propagates.

## Tools and structured output

Use `define_tool` with an explicit name, input schema, and optional executor.
All tools in one operation must have executors, or all must be manual. Plain JSON
Schema produces validated dictionary arguments. With the optional schemas extra,
Pydantic models and dataclasses produce validated instances. Annotate executor
parameters for editor typing.

A tool can declare a keyword-only `context` parameter to receive `ToolContext` and
its `cancel_event`. Tool executors may run on background threads even though the
public SDK is synchronous. Execution order/concurrency and execution timing are
separate options. Managed tool events are notifications, not approval checkpoints.
Manual applications can execute calls early from notifications or after inspecting
`result.tool_calls`; don't execute a call twice when it appears in both places.

Structured output accepts the same schema choices. It cannot be combined with
nonempty tools in the initial surface. Validation failure after normal completion
raises `GenerationError`; an expected early stop may have no validated output.
`output=None` can mean JSON null or absent output: use `stop_reason` to decide whether
your application accepts the result. There is no automatic conversation compaction.

```python
from wfloat import define_tool, StructuredOutput, tool_result

weather = define_tool(
    "weather",
    {"type": "object", "properties": {"city": {"type": "string"}},
     "required": ["city"], "additionalProperties": False},
    execute=lambda args: {"city": args["city"], "temperature_c": 18},
)
result = model.generate(messages, tools=[weather], max_rounds=20)

# Manual alternative: omit execute. Your application performs the action.
manual_weather = define_tool("weather", weather.json_schema)
result = model.generate(messages, tools=[manual_weather])
messages.extend(result.new_messages)
for call in result.tool_calls:
    messages.append(tool_result(call, {"temperature_c": 18}))
reply = model.generate(messages, tools=[manual_weather])

# Constrain the answer instead of using tools in this operation.
result = model.generate(messages, structured_output=StructuredOutput(
    schema={"type": "object", "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"], "additionalProperties": False},
))
print(result.output)
```

Schemas describe the model's JSON input/output. Optional Pydantic validators and
transforms run afterwards; a valid JSON shape does not guarantee those validators
accept it. `max_correction_attempts` defaults to zero. Unsupported JSON Schema
keywords are rejected explicitly rather than silently ignored.

## Speech generation

```python
from wfloat import load_text_to_speech

with load_text_to_speech("wfloat/wfloat-tts") as tts:
    result = tts.generate("Hello")
    result.audio.save("hello.wav")
```

For long speech, consume `generate_stream()` chunks incrementally. The SDK does not
retain the complete streamed recording. Each chunk carries audio, its offset and
available text alignment metadata. Retained chunks remain valid after advancing
or unloading. Returned audio uses owned, mono `float32` NumPy arrays.
Playback belongs to the application.

```python
with tts.generate_stream("First sentence. Second sentence.") as stream:
    for chunk in stream:
        consume_audio(chunk.audio.samples, chunk.audio.sample_rate)
        # chunk.start_ms and chunk.timeline locate its audio/text.
```

## Transcription and VAD

```python
from wfloat import load_speech_to_text

with load_speech_to_text("openai/whisper-tiny-en") as stt:
    result = stt.transcribe("recording.wav", language="en")
    print(result.text)
```

Audio inputs accept file paths, Wfloat audio objects, or NumPy samples with an
explicit `sample_rate`. Mono arrays have shape `(frames,)`; multichannel arrays
have shape `(frames, channels)`. Audio is downmixed/resampled as needed. File codec
support currently covers uncompressed 8/16/24/32-bit PCM WAV. Decode other formats
in your application and pass their NumPy samples. Inputs are never modified.

Live STT/VAD sessions process supplied audio synchronously through `push()` and end
input with `finish()`. A push processes available work without waiting for future
speech. The application owns its capture/network queue and backlog policy. Do not
perform inference directly inside a time-sensitive audio-device callback.

```python
from wfloat import load_streaming_speech_to_text

with load_streaming_speech_to_text("openai/whisper-tiny-en") as model:
    session = model.create_session(on_transcript=lambda event: print(event.text))
    try:
        for samples in application_audio_source():
            session.push(samples, sample_rate=16000)
        result = session.finish()
    finally:
        session.cancel()  # harmless after finish; cleans up on early exit
```

Whisper live transcription uses bounded recording windows; it is not a natively
streaming recognizer. Word timestamps require verified backend support and are
currently rejected; segment timings are available where supported.
The registered English Zipformer supports `hotwords=["Wfloat", "speech recognition"]`
on `transcribe()` and `create_session()`. Other models reject unsupported hotwords.

VAD `detect(..., return_audio=True)` returns detected clips for complete audio.
Live VAD delivers completed clips without retaining all of them in its final timing
summary. Timestamps are relative to the supplied audio/session, not wall-clock time.

## Cancellation and errors

Pass an optional standard-library `threading.Event` as `cancel_event`; a Stop button
or another thread calls `.set()`. Merely passing an event does not cancel anything.
Wfloat never clears the caller's event. Cancellation is cooperative at native safe
boundaries; arbitrary Python tool functions cannot be forcibly killed.

- LLM cancellation returns partial work with a cancelled stop reason.
- TTS cancellation raises `OperationCancelledError`; delivered chunks remain usable.
- Deliberately breaking iteration and exiting the stream context just cleans up.
- Running tools are signalled but cancellation does not wait indefinitely for tools
  ignoring it. Their side effects may still occur; late returns don't revive the run.
- LLM operation failures use `GenerationError.partial_result` and Python `__cause__`.
- Ordinary executor failures become model feedback by default; the stop policy is
  available. Callback failures are application exceptions, not tool feedback.

## Model files

```python
from wfloat import download_model, delete_model_assets

download_model("openai/whisper-tiny-en", on_progress=lambda event: print(event.phase, event.progress))
# Later, after unloading instances using these files:
delete_model_assets("openai/whisper-tiny-en")
```

Loads/downloads are blocking and accept `cancel_event`. Valid cached assets skip
download events. Downloads verify registry hashes, retain resumable partial files,
and report byte-based aggregate progress. Deletion preserves shared dependencies.
Loaded files are protected by leases; deleting files still used by a model raises
`ModelAssetsInUseError`. Cross-process conflicting cache mutations also fail
explicitly; independent cached readers are allowed.

## Compatibility

Legacy loader exports remain available with their legacy result objects. New
applications should use the model-type loaders above. Native inference cancellation
occurs at safe boundaries; an active speech decode may finish before stopping.
Model capabilities vary: unsupported options fail clearly rather than promising
features the selected backend cannot provide.

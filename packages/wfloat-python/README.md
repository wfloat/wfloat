# Wfloat for Python

Run language, speech synthesis, speech recognition and voice activity models locally.
The Python surface is synchronous: ordinary calls return results, streams use `for`,
and live recognition sessions accept application-supplied audio. Wfloat does not open
microphones or play sound in this release.

The model tables describe IDs integrated in this branch. Publication and platform qualification are ongoing; inclusion is not a claim of completed testing on every platform.

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

| Model IDs | Behavior |
| --- | --- |
| `HuggingFaceTB/SmolLM2-360M-Instruct` | Existing text-generation model. |
| `Qwen/Qwen3-0.6B`, `Qwen/Qwen3-1.7B` | Embedded thinking template; reasoning enabled unless explicitly disabled. |
| `Qwen/Qwen3-4B` | Same thinking behavior; limited smoke qualification only (see below). |
| `google/gemma-3-270m-it`, `google/gemma-3-1b-it` | Embedded Gemma text-chat template. |

Qwen 4B has passed bounded Web, Python and RN iOS/Android generation and
cached-reload checks at context 2048 with reasoning disabled. These checks do
not qualify physical-device performance, reasoning, tools, structured output
or long-context behavior for 4B.

Qwen and Gemma default to a 2048-token context. Model files, quantization and shard
layout are selected internally; there is no public quantization or shard selector.
Larger models need more memory even when their downloads are split into shards.
Qwen sampling defaults follow the reasoning mode; explicit sampling options take
precedence. Use `reasoning=False` to disable thinking and bound generation with `max_tokens_per_round`.

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

Gemma 3 1B uses the same API: `load_language_model("google/gemma-3-1b-it")`.
It defaults to a 2048-token context and the model's embedded chat template;
`context_size` and `chat_template` remain optional overrides. The SDK downloads
and verifies both native GGUF shards before loading, and keeps their canonical
sibling filenames in the cache.

Gemma downloads also include its terms (`gemma-terms.html`), prohibited-use policy
(`gemma-prohibited-use-policy.html`), `NOTICE.txt`, and `provenance.json` alongside
the shards. These accompanying documents describe the model's terms and source;
they do not replace the Python package license.

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

Additional speech-generation IDs use the existing loader and `voice_id` option:

| Model ID | Language / voice selection |
| --- | --- |
| `rhasspy/piper-en_US-lessac-medium` | US English; voice 0. |
| `rhasspy/piper-en_US-amy-medium` | US English; voice 0. |
| `rhasspy/piper-en_US-ryan-medium` | US English; voice 0. |
| `rhasspy/piper-en_GB-alba-medium` | British English; voice 0. |
| `rhasspy/piper-de_DE-thorsten-medium` | German; voice 0. |
| `rhasspy/piper-fr_FR-siwis-medium` | French; voice 0. |
| `rhasspy/piper-en_US-libritts-high` | US English; speaker IDs 0–903. |
| `hexgrad/Kokoro-82M` | American/British English, Spanish, French, Hindi, Italian, Brazilian Portuguese and Mandarin; named voices or numeric IDs. Japanese excluded. |
| `KittenML/kitten-tts-nano-0.8` | English; eight named voices or IDs 0–7; 24 kHz output. |
| `KittenML/kitten-tts-mini-0.8` | English; eight named voices or IDs 0–7; 24 kHz output. |

Kokoro Japanese voices (`jf_*`, `jm_*`, numeric IDs 37–41) are rejected: the current
frontend routes Han characters through Chinese pronunciation. Piper/Kokoro/Kitten do not
support reference-audio voice cloning. Shared eSpeak data is downloaded internally.

Kitten voice IDs 0–7 map to `Jasper`, `Bella`, `Bruno`, `Luna`, `Hugo`, `Rosie`,
`Leo`, and `Kiki`. Kitten requires the updated 0.8 frontend runtime and accepts
at most 65,536 Unicode codepoints per synthesis call. Limited Web, Python and
RN iOS/Android smoke checks have passed for Nano and Mini. The iOS runtime
requires the bundled ONNX Runtime 1.18.1 update for these exports.
These checks do not establish broad platform or pronunciation-quality coverage.

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

### Pocket TTS

```python
with load_text_to_speech("kyutai/pocket-tts") as tts:
    result = tts.generate("Hello from Pocket.", temperature=0.7,
                          inference_steps=5, seed=42)
    cloned = tts.generate("A reference voice.", reference_audio="reference.wav")
```

Pocket defaults to the bundled `alba` reference, temperature `0.7`, five inference
steps, and a random seed. `temperature` must be finite, nonnegative and
representable as float32. Positive temperatures below `2**-126` are rejected to
avoid native parsing fallback; zero is valid. `inference_steps` must be a positive signed int32;
`seed`, when supplied, must be a nonnegative signed int32.

`reference_audio` uses the transcription audio convention: an `Audio`, a PCM WAV
path, or NumPy samples with `sample_rate`. References are copied, downmixed and
resampled to mono 24 kHz. Empty references and references longer than 10 seconds
are rejected, never truncated. `sample_rate` describes the reference input only.
The preset selector accepts `voice_id="alba"`.

These options also work on `generate_stream()`, `generate_dialogue()` and
`generate_dialogue_stream()`, and on individual `SpeechSegment` objects or segment
mappings. Segment controls inherit operation defaults. A segment's explicit
`voice_id` or `reference_audio` replaces the operation's voice selection; selecting
both for the same resolved segment raises an error. Explicit `emotion`, `intensity`
and `speed` options warn because Pocket does not support them. Wfloat TTS retains
its existing controls. On a Wfloat model, explicit `temperature`, `seed` and
`inference_steps` are validated, then warn and have no effect; `reference_audio`
and `sample_rate` are rejected.

Pocket prepares units of about 200 characters at whitespace/punctuation, with a
Unicode-safe fallback, without Wfloat's phonemizer. Timelines preserve the original
text and Python string offsets at unit granularity. Cancellation is checked between
native units; a unit already synthesizing finishes before cancellation takes effect.

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

| Model IDs | Languages / tasks | Live recognition | Optional capabilities |
| --- | --- | --- | --- |
| `openai/whisper-tiny-en` | English transcription | Windowed | Segment timestamps |
| `openai/whisper-tiny`, `openai/whisper-base`, `openai/whisper-small` | Multilingual transcription; translation to English | Windowed | Segment timestamps |
| `UsefulSensors/moonshine-tiny`, `moonshine-ai/moonshine-base` | English transcription | Windowed | — |
| `k2-fsa/streaming-zipformer-en` | English transcription | Native incremental | English hotwords |
| `shaojieli/streaming-zipformer-fr` | French transcription | Native incremental | — |
| `k2-fsa/streaming-zipformer-zh-en` | Chinese/English transcription | Native incremental | — |
| `nvidia/parakeet-tdt-0.6b-v3` | Automatic recognition of 25 languages; transcription only | Windowed | — |

These adapters accept complete recordings and live sessions. Windowed live
recognition reruns offline recognition on bounded overlapping audio; it has
different latency and cost from native incremental recognition. Zipformer's
`language` validates compatibility rather than forcing the bilingual decoder.

Parakeet requires omitting `language`; translation, hotwords and word/segment
timestamp requests are unsupported. Its transport parts are reconstructed
internally before loading. Word timestamps are unavailable for the listed models;
segment timestamps are available only for Whisper. Predicted segment endpoints
are capped to the supplied audio duration (per processing window); text and start
times are preserved. Invalid or wholly out-of-range timings still fail. Other timing fields must not
be interpreted as word alignments. Unsupported options reject.

Recognition options belong on `transcribe()` / `create_session()`. Only
`k2-fsa/streaming-zipformer-en` accepts `hotwords`, for example
`hotwords=["Wfloat", "speech recognition"]`.

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

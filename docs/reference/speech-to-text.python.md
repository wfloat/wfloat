# Speech to text

```python
from wfloat import load_speech_to_text

with load_speech_to_text("openai/whisper-tiny-en") as model:
    result = model.transcribe("recording.wav", language="en")
    print(result.text, result.stop_reason)
```

## `transcribe(audio, **options)`

Blocks and returns a `TranscriptionResult`. Inputs: a PCM WAV file path, a Wfloat `Audio` object (including TTS `result.audio`), or a NumPy array with `sample_rate`. Arrays use `(frames,)` or `(frames, channels)`; Wfloat downmixes/resamples without changing your input. File decoding supports uncompressed 8/16/24/32-bit PCM WAV; decode other formats yourself and pass samples.

Options: `language`, `task="transcribe" | "translate"`, `timestamps="segment" | "word"`, `hotwords`, `on_transcript`, and `cancel_event`. Unsupported model options reject. Current adapters expose segment timestamps for Whisper but no word timestamps.

`on_transcript` receives a current whole-recording `text` preview, not a delta. Results include `text`, optional `segments` / `words`, and `stop_reason` (`"complete"` or `"cancelled"`). Optional `timing.start_ms` / `end_ms` are relative to the input. Cancellation preserves partial work and may include `provisional`. Failures raise `TranscriptionError` with `partial_result`.

## `load_streaming_speech_to_text()` and `create_session()`

```python
import numpy as np
from wfloat import load_streaming_speech_to_text

with load_streaming_speech_to_text("openai/whisper-tiny-en") as model:
    session = model.create_session(
        on_transcript=lambda event: print(event.id, event.text, event.is_final),
    )
    try:
        # Replace this silence with chunks from your application's audio source.
        session.push(np.zeros(16000, dtype=np.float32), sample_rate=16000)
        result = session.finish()
    finally:
        session.cancel()
```

Live events replace provisional text by utterance `id` (starting at `"0"`); `is_final` commits it. An empty update may clear a previous provisional transcript. Final segments retain utterance IDs.

`push()` processes available audio synchronously; your application owns microphone capture and its input queue. Avoid inference inside time-sensitive device callbacks. `finish()` ends input and flushes pending speech; `cancel()` preserves partial results. `result()` retrieves the terminal result after finishing/cancelling, or re-raises failure. One live session owns the model; conflicting operations reject.

Session options also accept `on_error` and `cancel_event`. `on_error` receives failures with preserved `partial_result`. Whisper-like models use overlapping windows; native streaming models process incrementally. Real-time performance depends on the model and device.

# Text to speech

```python
from wfloat import load_text_to_speech

with load_text_to_speech("wfloat/wfloat-tts") as model:
    result = model.generate("Hello.")
    result.audio.save("hello.wav")
```

## `generate()` and `generate_dialogue()`

`generate(text, **options)` returns a complete `SpeechResult`: `audio` and `timeline`. `generate_dialogue(segments, **options)` accepts `SpeechSegment` objects or dictionaries with `text`, synthesis options, and optional `pause_after_ms`. Blank text is rejected. `pause_between_segments_ms` supplies the default gap; segment options override operation options.

Options include `voice_id`, `speed`, `emotion`, `intensity`, `reference_audio`, `temperature`, `seed`, and `inference_steps`. Model pages specify support, voices, and defaults. Reference audio accepts the [transcription input formats](speech-to-text.python.md); raw arrays need `sample_rate`. A resolved segment cannot select both a reference and a voice.

`result.audio` is an `Audio` object with owned mono `float32` NumPy `samples` and `sample_rate`. It supports `save(path)` and `wav_bytes()`. Timeline entries include `segment_index`, `text`, `text_start`, `text_end`, `start_ms`, and `end_ms`. Timing precision is model-dependent, not necessarily word-level.

## `generate_stream()` and `generate_dialogue_stream()`

```python
# With the model still loaded:
with model.generate_stream("First sentence. Second sentence.") as stream:
    for chunk in stream:
        print(chunk.start_ms, chunk.audio.sample_rate, chunk.timeline)
        # Send chunk.audio.samples to your application's audio/file consumer.
```

Streaming retains no complete recording: consume or store chunks yourself. Delivered chunks remain valid after iteration advances or the model unloads. Each chunk has `audio`, `start_ms`, and `timeline`; there is no stream `result()` that collects everything.

Pass `cancel_event=threading.Event()` to an operation and set it from another thread to cancel. TTS cancellation raises `OperationCancelledError`; already delivered chunks remain usable. Breaking iteration and exiting the context cleans up without requiring an error handler.

Python does not provide `speak()` or microphone/playback management. Use application-owned playback and unload the model with `unload()` or a `with` block.

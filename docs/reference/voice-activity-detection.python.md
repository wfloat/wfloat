# Voice activity detection

```python
from wfloat import load_voice_activity_detection

with load_voice_activity_detection("snakers4/silero-vad") as model:
    result = model.detect("recording.wav", return_audio=True)
    for segment in result.segments:
        print(segment.start_ms, segment.end_ms)
        segment.audio.save(f"speech-{segment.id}.wav")
```

## `detect(audio, **options)`

Accepts the [same audio inputs as speech to text](speech-to-text.python.md); arrays need `sample_rate`. Returns a `DetectionResult` with `segments` and `stop_reason` (`"complete"` or `"cancelled"`). Each segment has `id`, `start_ms`, and `end_ms`; `return_audio=True` adds an `Audio` clip.

| Option | Meaning |
| --- | --- |
| `speech_threshold`, `silence_threshold` | Speech entry/exit thresholds. |
| `min_speech_duration_ms` | Minimum accepted speech duration. |
| `min_silence_duration_ms` | Silence needed to end a speech segment. |
| `speech_padding_ms` | Extra audio around detected speech. |
| `return_audio` | Include clips; default false. |
| `on_probability` | Receive `probability`, `start_ms`, and `end_ms`. |
| `cancel_event` | Cooperative cancellation using a `threading.Event`. |

Current defaults: speech threshold 0.5, silence threshold 0.15 below it, minimum speech 250 ms, minimum silence 500 ms, padding 30 ms. Thresholds/scores are not interchangeable across models. Padding is clamped to available audio and previous segment boundaries to avoid overlapping clips. Times are relative to supplied audio, not wall-clock time.

## `create_session(**options)`

```python
import numpy as np

# With the model still loaded:
session = model.create_session(
    return_audio=True,
    on_speech_end=lambda segment: print(segment.audio),
)
try:
    session.push(np.zeros(16000, dtype=np.float32), sample_rate=16000)
    summary = session.finish()
finally:
    session.cancel()
```

Sessions process application-supplied audio through synchronous `push()` and support `on_speech_start`, `on_speech_end`, and `on_error`. One session owns the model. Your application manages capture and buffering.

Live clips are delivered through `on_speech_end`; the final result contains timing ranges, not every clip. Retain callback audio yourself if needed. `finish()` flushes the last segment, `cancel()` preserves completed ranges, and `result()` retrieves the terminal result. Silence produces no speech segments. Failures raise `VadError` with `partial_result` and notify session `on_error`.

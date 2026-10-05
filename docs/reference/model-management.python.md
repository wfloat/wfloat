# Model management

```python
from wfloat import download_model, load_text_to_speech, delete_model_assets

model_id = "wfloat/wfloat-tts"
download_model(model_id, on_progress=lambda event: print(event.phase))
with load_text_to_speech(model_id) as model:
    result = model.generate("Hello.")
delete_model_assets(model_id)
```

| Call | Effect |
| --- | --- |
| `download_model(model_id, ...)` | Cache assets without loading a model. |
| `load_language_model()`, `load_text_to_speech()`, `load_speech_to_text()`, `load_streaming_speech_to_text()`, `load_voice_activity_detection()` | Download missing assets and return the corresponding model. |
| `model.unload()` or leaving its `with` block | Release the model; keep cached assets. |
| `delete_model_assets(model_id, ...)` | Delete private assets; keep shared dependencies. |

Loaders/downloads block until complete. Options are keyword-only: `cache_dir`, `on_progress`, and `cancel_event` (a `threading.Event` another thread can set). Cancellation is cooperative; the SDK never clears your event. Reuse the same `cache_dir` when loading, downloading, and deleting.

`on_progress` receives phases `checking`, `downloading`, `loading`, and `ready`. Download fields are `downloaded_bytes`, optional `total_bytes`, `progress` (0–1), `bytes_per_second`, and `estimated_time_remaining_ms`. Cached assets skip downloading; interrupted downloads retain resumable partial files.

Unload instances before deleting their assets. Files in use raise `ModelAssetsInUseError`; conflicting cross-process cache changes fail explicitly. Model IDs and capabilities are listed in the [model catalog](https://wfloat.com/models).

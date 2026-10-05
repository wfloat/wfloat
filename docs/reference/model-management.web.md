# Model management

```ts
import { downloadModel, loadTextToSpeech, deleteModelAssets } from '@wfloat/wfloat-web';

const id = 'wfloat/wfloat-tts';
await downloadModel(id, {
  onProgress: event => {
    if (event.phase === 'downloading') console.log(event.progress);
  },
});
const model = await loadTextToSpeech(id);
await model.unload();
await deleteModelAssets(id);
```

| Call | Effect |
| --- | --- |
| `downloadModel(id, options?)` | Cache assets without loading a model. |
| `loadLanguageModel()`, `loadTextToSpeech()`, `loadSpeechToText()`, `loadStreamingSpeechToText()`, `loadVoiceActivityDetection()` | Download missing assets and return the corresponding model. |
| `model.unload()` | Release the instance and stop its operations; retain cached assets. |
| `deleteModelAssets(id)` | Delete this model's private assets; retain shared dependencies. |

Load/download options include `onProgress` and an optional `AbortSignal` as `signal`. Aborting detaches that caller; another caller sharing the download can continue. Partial downloads are retained for resume. Deleting assets interrupts affected downloads/loads.

Progress phases are `checking`, `downloading`, `loading`, and `ready`. Verified cached assets skip `downloading`. Download events report aggregate `downloadedBytes`, and when known, `totalBytes`, `progress` (0–1), `bytesPerSecond`, and `estimatedTimeRemainingMs`. Loading progress is optional.

Separate loaded instances have separate ownership. Model IDs and available capabilities are listed in the [model catalog](https://wfloat.com/models).

## Browser storage

Load/download options also accept `persistence`: `"auto"` (default) requests persistent storage only in recognized browsers expected to decide silently; `"request"` allows a browser prompt; `"off"` skips the request. This applies to the website's origin, not one model. It does not disable caching or revoke an existing grant.

Persistence is best effort; browsers and users can still remove data. Storage failures reject rather than silently switching to memory-only downloads.

# Model management

```ts
import { downloadModel, loadTextToSpeech, deleteModelAssets } from '@wfloat/react-native-wfloat';

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

## App storage

Assets use app-private storage excluded from backups. There is no browser `persistence` option. Unloading and deleting cached files are separate operations.

# Speech to text

```ts
import { loadSpeechToText } from '@wfloat/wfloat-web';

const model = await loadSpeechToText('openai/whisper-tiny-en');
// recording.wav is a file served by your application.
const audio = await fetch('/recording.wav').then(response => response.blob());
const operation = model.transcribe(audio, {
  onTranscript: event => console.log(event.text),
});
const result = await operation.result();
console.log(result.text, result.stopReason);
await model.unload();
```

Inputs: mono `{ samples: Float32Array, sampleRate }`, browser `File`/`Blob`, or `AudioBuffer`. File formats depend on browser decoding support. Wfloat downmixes/resamples as needed. TTS `result.audio` is also valid input.

## `transcribe(audio, options?)`

Returns a handle with `result()` and `cancel()`. `onTranscript({ text })` contains the current whole-recording preview, not a text delta. Some models only provide a final update.

Results contain `text`, optional `segments` / `words`, and `stopReason` (`"complete"` or `"cancelled"`). Timing, when available, uses `{ startMs, endMs }` relative to the input. Cancellation preserves partial text and may include `provisional`; failures reject with `TranscriptionError.partialResult` and `cause`.

Options on `transcribe()` or `createSession()`: `language`, `task: "transcribe" | "translate"`, `timestamps: "segment" | "word"`, and `hotwords`. Support is model-specific; unsupported requests reject. Current adapters expose segment timestamps for Whisper but no word timestamps.

## `loadStreamingSpeechToText()` and `createSession()`

```ts
import { loadStreamingSpeechToText } from '@wfloat/wfloat-web';

const live = await loadStreamingSpeechToText('openai/whisper-tiny-en');
const session = await live.createSession({
  onTranscript: event => console.log(event.id, event.text, event.isFinal),
  onError: error => console.error(error),
});
await session.startMicrophone(); // Start from a user action.
// Later, when the user stops recording:
const result = await session.finish();
await live.unload();
```

Live updates replace provisional text by utterance `id` (starting at `"0"`); `isFinal` commits it. Empty updates can clear a previous provisional transcript. The final result includes segments with those IDs.

Alternatively, `await session.push({ samples, sampleRate })` supplies mono PCM. It acknowledges acceptance, not completed recognition or backpressure. `finish()` ends input and drains pending work; `result()` waits without ending input; `cancel()` stops and preserves partial results. One live session owns an instance; conflicting work rejects.

There is no default backlog limit. Set `maxBufferedAudioMs` on `createSession()` to bound pending audio; exceeding it fails with preserved transcript. Wfloat warns about growing backlog and never silently drops audio. Whisper-like models use overlapping windows; native streaming models process incrementally. Neither guarantees real-time speed on every device.

## Shared microphone

`createMicrophoneCapture()` creates a reusable source. Attach it to STT/VAD sessions with `attachMicrophone(source)` before pushing or starting capture, then call `source.start()`. Call `source.stop()` to stop shared capture; finish each session separately. A session cannot mix attached-microphone and manually pushed input.

Microphone input requires HTTPS or localhost and user permission.

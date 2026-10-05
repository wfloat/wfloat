# Voice activity detection

```ts
import { loadVoiceActivityDetection } from '@wfloat/react-native-wfloat';

const model = await loadVoiceActivityDetection('snakers4/silero-vad');
const audio = { samples: new Float32Array(16000), sampleRate: 16000 }; // One second of silence.
const detection = model.detect(audio, { returnAudio: true });
const result = await detection.result();
console.log(result.segments);
await model.unload();
```

## `detect(audio, options?)`

Accepts the same [audio inputs as speech to text](speech-to-text.react-native.md). Returns a handle with `result()` and `cancel()`. Results contain `segments` and `stopReason: "complete" | "cancelled"`. A segment has `id`, `startMs`, and `endMs`; `returnAudio: true` adds its `audio`.

| Option | Meaning |
| --- | --- |
| `speechThreshold`, `silenceThreshold` | Speech entry/exit thresholds. |
| `minSpeechDurationMs` | Minimum accepted speech duration. |
| `minSilenceDurationMs` | Silence needed to end a speech segment. |
| `speechPaddingMs` | Extra audio around detected speech. |
| `returnAudio` | Include completed speech clips; default false. |
| `onProbability` | Receive `{ probability, startMs, endMs }` model scores. |

Current defaults: speech threshold 0.5, silence threshold 0.15 below it, minimum speech 250 ms, minimum silence 500 ms, padding 30 ms. Scores and threshold effectiveness are not interchangeable across models. Padding is clamped to available audio and previous segment boundaries to avoid overlapping clips.

## `createSession(options?)`

```ts
// With the model still loaded:
const session = await model.createSession({
  returnAudio: true,
  onSpeechStart: event => console.log('Speech started', event.startMs),
  onSpeechEnd: event => console.log(event.audio),
  onError: error => console.error(error),
});
await session.startMicrophone(); // From a user action.
// Later:
const summary = await session.finish();
```

Sessions also support `push({ samples, sampleRate })`, `attachMicrophone(source)`, `result()`, and `cancel()`. `finish()` ends input and flushes the last segment; `result()` only waits. One session owns the model at a time.

Live `onSpeechEnd` delivers clips when `returnAudio` is enabled. The final session result retains timing ranges, **not all audio clips**; keep callback clips yourself if needed. Times are relative to the supplied audio/session. Silence produces no speech segments. Failures use `VadError.partialResult` and session `onError`.

See [speech to text](speech-to-text.react-native.md) for shared microphone setup and platform-specific capture behavior.

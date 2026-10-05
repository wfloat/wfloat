# Text to speech

```ts
import { loadTextToSpeech } from '@wfloat/react-native-wfloat';

const model = await loadTextToSpeech('wfloat/wfloat-tts');
const generation = model.generate('Hello.');
const result = await generation.result();
console.log(result.audio.samples, result.audio.sampleRate, result.timeline);
generation.dispose();
await model.unload();
```

## `generate()` and `generateDialogue()`

`generate(text, options?)` retains generated audio. `generateDialogue(segments, options?)` accepts `{ text, voiceId?, pauseAfterMs?, ... }` segments. Blank text is rejected. `pauseBetweenSegmentsMs` sets the dialogue default; segment options override operation options.

Options include `voiceId`, `speed`, `emotion`, `intensity`, `referenceAudio`, `temperature`, `seed`, and `inferenceSteps`. Availability, voices, and defaults depend on the model; check its model page. Reference audio and voice selection are alternatives, not simultaneous inputs.

The generation exposes `finished`, `result()`, `audio` (an async iterable), `speak()`, and `dispose()`. These read the same retained generation; reading chunks does not discard its audio. `dispose()` stops unfinished work and releases SDK references, including dependent playback.

Each chunk has `{ audio, startMs, timeline }`. Audio is mono `{ samples: Float32Array, sampleRate }`. Timeline entries contain `segmentIndex`, `text`, text offsets `textStart`/`textEnd`, and audio times `startMs`/`endMs`. Alignment precision depends on the model; word-level timing is not guaranteed. Treat returned samples as read-only; copy before modifying or transferring them.

## `speak()` and `speakDialogue()`

```ts
// From a user action, with the model already loaded:
const speech = model.speak('Hello.', {
  onPlayback: event => console.log(event.state, event.highlight),
});
// Later: speech.pause(); speech.resume(); speech.cancel();
```

Playback starts when enough audio is buffered; it does not wait for the whole text. Its handle has `pause()`, `resume()`, and `cancel()`. Completion is reported through `onPlayback`, not a playback `finished` promise.

States: `buffering`, `playing`, `paused`, `finished`, `cancelled`, `failed`. `highlight` contains the current text range or is `null` during silence/terminal states; `failed` also includes `error`.

Use `generation.speak({ onPlayback })` to play retained audio from the beginning, including while generation continues. Each call creates a separate playback handle. Direct `model.speak()` discards played audio; `generate()` retains it until disposal. New speech on the same instance pauses its previous playback; different instances can overlap.

## Native playback

Playback options include `backgroundBehavior` (`"pauseUntilResumed"` by default, `"pauseAndAutoResume"`, or `"continue"`) and `audioFocus` (`"interruptOthers"` by default, `"duckOthers"`, or `"mixWithOthers"`). Resume paused speech through its handle.

Continued background audio requires iOS `UIBackgroundModes: audio` and Android foreground-service setup; see the [microphone/background setup](speech-to-text.react-native.md). Playback-only Android apps need the `mediaPlayback` service type and permission, not microphone permission. Background playback does not promise arbitrary background inference jobs.

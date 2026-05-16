# @wfloat/react-native-wfloat

`@wfloat/react-native-wfloat` adds Wfloat text-to-speech and speech-to-text to React Native apps on iOS and Android.

## Install

```bash
npm install @wfloat/react-native-wfloat
```

```bash
yarn add @wfloat/react-native-wfloat
```

## iOS setup

Install CocoaPods dependencies from your app's `ios/` directory:

```bash
cd ios
pod install
cd ..
```

React Native autolinking handles Android integration after the package is installed.

## Quick start

Your `modelId` is the Wfloat model identifier you want to load, for example
`wfloat/wfloat-tts`.

```tsx
import { loadTtsModel } from '@wfloat/react-native-wfloat';

const modelId = 'wfloat/wfloat-tts';

const tts = await loadTtsModel(modelId, {
  onProgress(event) {
    if (event.status === 'downloading') {
      console.log('Downloading', Math.round(event.progress * 100) + '%');
      return;
    }

    if (event.status === 'loading') {
      console.log('Initializing native runtime');
      return;
    }

    console.log('Model ready');
  },
});

const result = await tts.synthesize({
  text: "All systems are stable. You can begin the launch sequence.",
  voice: 'narrator_woman',
  emotion: 'neutral',
  intensity: 0.5,
  speed: 1,
  silencePaddingSec: 0.1,
  onProgress(event) {
    console.log('progress', event.progress);
    console.log('isPlaying', event.isPlaying);
    console.log('highlight', event.textHighlightStart, event.textHighlightEnd);
    console.log('chunkText', event.text);
  },
  onFinishedPlaying() {
    console.log('Playback finished');
  },
});

console.log(result.audio.sampleRate, result.audio.durationSec);
console.log(result.timeline.chunks);
```

## STT quick start

Offline STT with Whisper:

```tsx
import { loadSttModel } from '@wfloat/react-native-wfloat';

const stt = await loadSttModel('openai/whisper-tiny-en', {
  language: 'en',
});

const result = await stt.transcribe({
  audio: pcmSamples,
  sampleRate: 16000,
});

console.log(result.text);
```

Offline STT from the microphone:

```tsx
import { loadSttModel } from '@wfloat/react-native-wfloat';

const stt = await loadSttModel('openai/whisper-tiny-en', {
  language: 'en',
});

await stt.startMicrophone();

// later, from a Stop button click
const clip = await stt.stopMicrophone();
const result = await stt.transcribe(clip);

console.log(result.text);
```

Streaming STT with Zipformer:

```tsx
import { loadSttModel } from '@wfloat/react-native-wfloat';

const stt = await loadSttModel('k2-fsa/streaming-zipformer-en');
const session = await stt.createSession();

await session.startMicrophone({
  onResult(partial) {
    console.log(partial.text);
  },
});

// later, from a Stop button click
await session.stopMicrophone();

const finalResult = await session.finish();
console.log(finalResult.text);
await session.close();
```

## API overview

- `loadTtsModel(modelId, { onProgress })` loads the model for the current
  device. The first load downloads the model and native support assets for the
  platform.
- `loadSttModel(modelId, { onProgress })` loads the STT model for the current
  device. Offline families use `transcribe(...)`; streaming families use
  `createSession()`.
- `tts.synthesize(options)` generates a single utterance and returns structured
  metadata about the audio and timeline.
- `tts.synthesizeDialogue(options)` generates multi-speaker dialogue and
  returns structured timeline metadata with `segmentIndex`.
- `stt.transcribe(options)` runs one-shot STT for offline-capable models like
  Whisper.
- `stt.createSession()` opens a streaming session for streaming-capable models
  like Zipformer.
- `stt.startMicrophone()` / `stt.stopMicrophone()` record microphone audio for
  one-shot offline STT.
- `session.startMicrophone({ onResult })` / `session.stopMicrophone()` capture
  microphone audio and feed a streaming STT session.
- `session.push(...)` and `session.getResult()` remain available for advanced
  callers that already own their audio pipeline.
- `tts.pause()` and `tts.play()` control playback for the active request.

## Progress callbacks

`loadTtsModel(...)` and `loadSttModel(...)` emit:

```ts
{ status: "downloading", progress: number }
{ status: "loading" }
{ status: "completed" }
```

`synthesize(...)` and `synthesizeDialogue(...)` emit:

```ts
{
  progress: number;
  isPlaying: boolean;
  textHighlightStart: number;
  textHighlightEnd: number;
  text: string;
  textHighlightSegment?: number;
}
```

## Dialogue example

```tsx
const result = await tts.synthesizeDialogue({
  silenceBetweenSegmentsSec: 0.2,
  onProgress(event) {
    console.log(event.progress);
  },
  onFinishedPlaying() {
    console.log('Dialogue finished');
  },
  segments: [
    {
      text: 'We only get one pass at this.',
      voice: 'narrator_man',
      emotion: 'neutral',
    },
    {
      text: "Then let's make the first pass count.",
      voice: 'strong_hero_woman',
      emotion: 'joy',
      intensity: 0.65,
    },
  ],
});

console.log(result.timeline.chunks);
```

## Useful exports

The package also exports `SPEAKER_IDS`, `VALID_EMOTIONS`, and `VALID_SIDS` for
building voice pickers and validating user input.

## Notes

- React Native currently returns structured audio metadata
  (`sampleRate` and `durationSec`) plus the timeline. It does not currently
  expose raw PCM samples to JavaScript the way the web package can.
- Current React Native STT families:
  - `openai/whisper-tiny-en` for offline `transcribe(...)`
  - `k2-fsa/streaming-zipformer-en` for streaming `createSession()`
- Microphone capture helpers are currently implemented for iOS. Android STT
  model loading and manual audio APIs are present, but Android microphone
  capture still needs the matching package-owned native implementation.

## Contributing

Maintainer and local development notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

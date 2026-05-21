# @wfloat/wfloat-web

`@wfloat/wfloat-web` is the browser package for Wfloat speech models. It
currently exposes text-to-speech, speech-to-text, and voice activity detection
in the browser.

Browser demo to hear how it sounds: https://wfloat.com/demo

## Install

```bash
npm install @wfloat/wfloat-web
```

```bash
yarn add @wfloat/wfloat-web
```

## Quick start

Your `modelId` is the Wfloat model identifier you want to load, for example
`wfloat/wfloat-tts`.

```ts
import { loadTtsModel } from "@wfloat/wfloat-web";

const modelId = "wfloat/wfloat-tts";

const tts = await loadTtsModel(modelId, {
  onProgress(event) {
    if (event.status === "downloading") {
      console.log("Downloading", Math.round(event.progress * 100) + "%");
      return;
    }

    if (event.status === "loading") {
      console.log("Initializing runtime");
      return;
    }

    console.log("Model ready");
  },
});

const result = await tts.synthesize({
  text: "The signal is clean. Start the recording.",
  voice: "narrator_woman",
  emotion: "neutral",
  intensity: 0.5,
  speed: 1,
  silencePaddingSec: 0.1,
  onProgress(event) {
    console.log("progress", event.progress);
    console.log("isPlaying", event.isPlaying);
    console.log("highlight", event.textHighlightStart, event.textHighlightEnd);
    console.log("chunkText", event.text);
  },
  onFinishedPlaying() {
    console.log("Playback finished");
  },
});

console.log(result.audio.sampleRate, result.timeline.chunks.length);
```

## API overview

- `loadTtsModel(modelId, { onProgress })` loads the model onto the device. The first load downloads model and runtime assets for the browser.
- `tts.synthesize(options)` generates a single utterance and returns `{ audio, timeline, modelId, text }`.
- `tts.synthesizeDialogue(options)` generates multi-speaker dialogue from a list of segments and returns the same structured result shape.
- `tts.pause()`, `tts.play()`, and `tts.stop()` control playback for the active request on that model instance.
- `loadSttModel(modelId, { onProgress })` loads an offline STT model into the browser worker.
- `stt.transcribe({ audio, sampleRate? })` transcribes a single audio input and returns `{ text, tokens?, segments?, ... }`.
- `stt.startMicrophone()` / `stt.stopMicrophone()` record browser mic audio for one-shot offline STT flows.
- `session.startMicrophone()` / `session.stopMicrophone()` capture browser mic audio and feed a streaming STT session.
- `createMicrophoneCapture({ sampleRate? })` remains available as a lower-level browser mic helper when you need custom capture control.
- streaming-capable STT models may also expose `await stt.createSession()` for incremental transcription.
- `loadVadModel(modelId, { onProgress })` loads a VAD model into the browser worker.
- `vad.detect({ audio, sampleRate? })` returns speech segments with timing and segment audio.
- `vad.createSession({ onSpeechStart, onSpeechEnd })` creates a live VAD session. `session.startMicrophone()` starts package-owned browser microphone capture, and `session.stopMicrophone()` stops capture, flushes the detector, and returns capture stats.

## Progress callbacks

`loadTtsModel(...)` emits:

```ts
{ status: "downloading", progress: number }
{ status: "loading" }
{ status: "completed" }
```

`synthesize(...)` emits:

```ts
{
  progress: number;
  isPlaying: boolean;
  textHighlightStart: number;
  textHighlightEnd: number;
  text: string;
}
```

`synthesizeDialogue(...)` emits the same fields plus `textHighlightSegment`.

## Dialogue example

```ts
const result = await tts.synthesizeDialogue({
  silenceBetweenSegmentsSec: 0.2,
  onProgress(event) {
    console.log(event.progress);
  },
  onFinishedPlaying() {
    console.log("Dialogue finished");
  },
  segments: [
    {
      text: "The door is locked.",
      voice: "narrator_man",
      emotion: "neutral",
    },
    {
      text: "Then we open it the loud way.",
      voice: "strong_hero_woman",
      emotion: "joy",
      intensity: 0.65,
    },
  ],
});

console.log(result.timeline.chunks.map((chunk) => chunk.segmentIndex));
```

## STT quick start

```ts
import { loadSttModel } from "@wfloat/wfloat-web";

const stt = await loadSttModel("openai/whisper-tiny-en", {
  onProgress(event) {
    console.log(event.status);
  },
});

const result = await stt.transcribe({
  audio: fileInput.files![0],
});

console.log(result.text);
console.log(result.tokens?.length ?? 0);
```

## Microphone capture quick start

```ts
import { loadSttModel } from "@wfloat/wfloat-web";

const stt = await loadSttModel("openai/whisper-tiny-en");

await stt.startMicrophone({ sampleRate: 16000 });

// later, from a Stop button click
const audio = await stt.stopMicrophone();

const result = await stt.transcribe(audio);

console.log(result.text);
```

This is meant for one-shot browser STT flows such as:
- record
- stop
- transcribe

For custom capture pipelines, `createMicrophoneCapture({ sampleRate })` is also
exported as a lower-level helper.

## Streaming STT direction

The first streaming web STT target is a sherpa online recognizer path for:

- `k2-fsa/streaming-zipformer-en`

Intended shape:

```ts
const stt = await loadSttModel("k2-fsa/streaming-zipformer-en", {
  modelAssetHost: "http://localhost:4000",
});

const session = await stt.createSession();

await session.startMicrophone({
  sampleRate: 16000,
  onResult(partial) {
    console.log(partial.text, partial.isEndpoint);
  },
});

// later, from a Stop button click
await session.stopMicrophone();

const finalResult = await session.finish();
console.log(finalResult.text);
await session.close();
```

This path is now implemented in the package surface, but it still depends on
the corresponding streaming model assets being staged in the asset API /
registry.

## VAD quick start

```ts
import { loadVadModel } from "@wfloat/wfloat-web";

const vad = await loadVadModel("silero-vad", {
  onProgress(event) {
    console.log(event.status);
  },
});

const result = await vad.detect({
  audio: fileInput.files![0],
});

console.log(result.segments.length);
console.log(result.speechRatio);
```

Live VAD from the browser microphone:

```ts
const vad = await loadVadModel("silero-vad");

const session = await vad.createSession({
  onSpeechStart(event) {
    console.log("speech started near", event.startSec);
  },
  onSpeechEnd(segment) {
    console.log("speech segment", segment.startSec, segment.endSec);
  },
});

await session.startMicrophone();

// later, from a Stop button click
const stats = await session.stopMicrophone();
console.log(stats.speechEndCount, stats.maxRms);
await session.close();
```

The web VAD path uses the shared sherpa speech WASM runtime and expects a
manifest with `files.model` plus `runtime.wasm_binary`. Browser microphone
capture is package-owned for live VAD; apps do not need to wire microphone
chunks into the worker manually.

## Local API override

For smoke tests against a local asset API, pass `modelAssetHost` when loading
the model:

```ts
const tts = await loadTtsModel("wfloat/wfloat-tts", {
  modelAssetHost: "http://localhost:4000",
});

const stt = await loadSttModel("openai/whisper-tiny-en", {
  modelAssetHost: "http://localhost:4000",
});

const vad = await loadVadModel("silero-vad", {
  modelAssetHost: "http://localhost:4000",
});
```

## Local smoke page

For a quick browser smoke test from this repo:

1. Build the package output so `dist/index.js`, `dist/worker/worker-inline.js`, and `dist/wasm/sherpa-onnx-wasm-main-speech.js` are current.
2. From `packages/wfloat-web`, start a static server such as `python3 -m http.server 4173`.
3. Open `http://localhost:4173`.
4. Leave the default asset host as `http://localhost:4000` if your local Phoenix asset API is running there.

The smoke page exercises:
- shared sherpa speech wasm runtime loading
- manifest fetch from the local asset API
- `espeak-ng-data` zip staging
- model download
- browser TTS synthesis and playback controls
- optional browser STT loading and transcription from an uploaded audio file
- browser microphone capture with record -> stop -> transcribe
- browser VAD loading, file-based speech segment detection, and live microphone
  VAD sessions

Current note: the local STT smoke path depends on the asset API returning the
uploaded Whisper tiny English files now stored at:
- `models/openai/whisper-tiny-en/tiny.en-encoder.int8.onnx`
- `models/openai/whisper-tiny-en/tiny.en-decoder.int8.onnx`
- `models/openai/whisper-tiny-en/tiny.en-tokens.txt`

## Browser note

Start generation from a user gesture such as a button click. Browsers can block audio playback until the page has received user interaction.

## Useful exports

The package also exports `SPEAKER_IDS`, `VALID_EMOTIONS`, and `VALID_SIDS` for
building voice pickers and validating user input.

## Contributing

Maintainer and local development notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

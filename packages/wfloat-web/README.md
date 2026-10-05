> For the new model-instance TTS/LLM APIs and durable asset lifecycle, see [API.md](API.md). The examples below describe the retained legacy API.

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
- `loadSpeechToText(id)` returns a model with `transcribe(audio, options)` operation handles.
- `loadStreamingSpeechToText(id)` returns a model with live `createSession(options)` support.
- Live sessions accept application PCM or own microphone capture, and expose `finish()`, `result()` and `cancel()`.
- Both loaders share cached asset management and support `unload()`; see [API.md](API.md).

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

## Speech-to-text

```ts
import { loadSpeechToText, loadStreamingSpeechToText } from "@wfloat/wfloat-web";

const model = await loadSpeechToText("openai/whisper-tiny-en");
const transcription = model.transcribe(fileInput.files![0], {
  onTranscript: ({ text }) => { preview.textContent = text; },
});
const result = await transcription.result();
console.log(result.text);
await model.unload();

const liveModel = await loadStreamingSpeechToText("k2-fsa/streaming-zipformer-en");
const session = await liveModel.createSession({
  onTranscript: ({ id, text, isFinal }) => updateUtterance(id, text, isFinal),
  onError: error => showError(error.message, error.partialResult),
});
startButton.onclick = () => session.startMicrophone().catch(showError);
stopButton.onclick = async () => console.log(await session.finish());
```

Complete-audio input supports File/Blob, AudioBuffer, and `{ samples, sampleRate }`.
For application-owned live audio, use `await session.push({ samples, sampleRate })`
instead of its microphone. Push acknowledges acceptance, not processing/backpressure.
There is no default backlog cap; optional `maxBufferedAudioMs` stops the session
with a recoverable error if pending audio exceeds an application-selected limit.

See [API.md](API.md#complete-audio-transcription) for cancellation, input ownership,
options, current model support and lifecycle details. Legacy `loadSttModel` remains
available separately during migration.

## VAD quick start

```ts
import { loadVadModel } from "@wfloat/wfloat-web";

const vad = await loadVadModel("snakers4/silero-vad", {
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
const vad = await loadVadModel("snakers4/silero-vad");

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

The web VAD path uses the shared sherpa speech WASM runtime. Browser microphone
capture is package-owned for live VAD; apps do not need to wire microphone
chunks into the worker manually.

## Local smoke page

For a quick browser smoke test from this repo:

1. Run `npm run build:wasm && npm run build:dev` so the package, module worker, and local WASMs in `dist` are current.
2. From `packages/wfloat-web`, start a static server such as `python3 -m http.server 4173`.
3. Open `http://localhost:4173`.

The smoke page exercises:
- shared sherpa speech wasm runtime loading
- `espeak-ng-data` zip staging
- model download
- browser TTS synthesis and playback controls
- optional browser STT loading and transcription from an uploaded audio file
- browser microphone capture with record -> stop -> transcribe
- browser VAD loading, file-based speech segment detection, and live microphone
  VAD sessions

## Browser note

Start generation from a user gesture such as a button click. Browsers can block audio playback until the page has received user interaction.

## Useful exports

The package also exports `SPEAKER_IDS`, `VALID_EMOTIONS`, and `VALID_SIDS` for
building voice pickers and validating user input.

## Contributing

Maintainer and local development notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

# @wfloat/wfloat-web

`@wfloat/wfloat-web` is the browser package for Wfloat text-to-speech. Use it to turn text into spoken audio on your website.

Browser demo to hear how it sounds: https://wfloat.com/demo

## Install

```bash
npm install @wfloat/wfloat-web
```

```bash
yarn add @wfloat/wfloat-web
```

## Quick start

Your `modelId` is the **Model Credential** shown in your Wfloat account after [sign up](https://wfloat.com/).

```ts
import { loadTtsModel } from "@wfloat/wfloat-web";

const modelId = "your-model-credential";

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

## Browser note

Start generation from a user gesture such as a button click. Browsers can block audio playback until the page has received user interaction.

## Useful exports

The package also exports `SPEAKER_IDS`, `VALID_EMOTIONS`, and `VALID_SIDS` for
building voice pickers and validating user input.

## Contributing

Maintainer and local development notes live in [CONTRIBUTING.md](CONTRIBUTING.md).

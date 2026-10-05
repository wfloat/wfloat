# Wfloat for Web

The Wfloat SDK for on-device inference in desktop and mobile browsers. Supports language models, text-to-speech, speech-to-text, and voice activity detection.

## Install

```sh
npm install @wfloat/wfloat-web
```

Use browser-side code with a bundler that supports module workers, such as Vite. Do not load models during server rendering.

[Installation details](https://wfloat.com/docs/how-to/installation?platform=web) · [Models and examples](https://wfloat.com/models)

## Example

```ts
import { loadLanguageModel } from '@wfloat/wfloat-web';

const model = await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct');
const generation = model.generate(
  [{ role: 'user', content: 'Hello!' }],
  { maxTokensPerRound: 128 },
);
const result = await generation.result();
console.log(result.text);
await model.unload();
```

The first load downloads the model files; later loads reuse cached files.

## Documentation

- [Language model](https://wfloat.com/docs/reference/language-models?platform=web)
- [Text to speech](https://wfloat.com/docs/reference/text-to-speech?platform=web)
- [Speech to text](https://wfloat.com/docs/reference/speech-to-text?platform=web)
- [Voice activity detection](https://wfloat.com/docs/reference/voice-activity-detection?platform=web)
- [Model management](https://wfloat.com/docs/reference/model-management?platform=web)

For local development, see [CONTRIBUTING.md](https://github.com/wfloat/wfloat/blob/main/packages/wfloat-web/CONTRIBUTING.md).

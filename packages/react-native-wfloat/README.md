# Wfloat for React Native

The Wfloat SDK for on-device inference in React Native apps on iOS and Android. Supports language models, text-to-speech, speech-to-text, and voice activity detection.

## Install

```sh
npm install @wfloat/react-native-wfloat

# Run this for iOS build
cd ios && pod install
```

Rebuild your native app after installing. Android uses autolinking. Expo Go is not supported; use a native development build.

[Installation details](https://wfloat.com/docs/how-to/installation?platform=react-native) · [Models and examples](https://wfloat.com/models)

## Example

```ts
import { loadLanguageModel } from '@wfloat/react-native-wfloat';

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

- [Language model](https://wfloat.com/docs/reference/language-models?platform=react-native)
- [Text to speech](https://wfloat.com/docs/reference/text-to-speech?platform=react-native)
- [Speech to text](https://wfloat.com/docs/reference/speech-to-text?platform=react-native)
- [Voice activity detection](https://wfloat.com/docs/reference/voice-activity-detection?platform=react-native)
- [Model management](https://wfloat.com/docs/reference/model-management?platform=react-native)

For local development, see [CONTRIBUTING.md](https://github.com/wfloat/wfloat/blob/main/packages/react-native-wfloat/CONTRIBUTING.md).

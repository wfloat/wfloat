# Wfloat

Wfloat provides on-device AI SDKs for Web, React Native, and Python. It supports language models, text-to-speech, speech-to-text, and voice activity detection.

## Get started

| SDK | Package | Installation |
| --- | --- | --- |
| Web | [`@wfloat/wfloat-web`](https://www.npmjs.com/package/@wfloat/wfloat-web) | [Browsers](https://wfloat.com/docs/how-to/installation?platform=web) |
| React Native | [`@wfloat/react-native-wfloat`](https://www.npmjs.com/package/@wfloat/react-native-wfloat) | [iOS and Android](https://wfloat.com/docs/how-to/installation?platform=react-native) |
| Python | [`wfloat`](https://pypi.org/project/wfloat/) | [macOS, Windows, and Linux](https://wfloat.com/docs/how-to/installation?platform=python) |

[Supported models and examples](https://wfloat.com/models) · [API documentation](https://wfloat.com/docs)

## This repository

- [`packages/`](packages/): platform SDKs. Each package includes development instructions in its `CONTRIBUTING.md`.
- [`native/wfloat-core/`](native/wfloat-core/): shared native runtime.
- [`vendor/`](vendor/): inference engines, including llama.cpp and sherpa-onnx.
- [`assets/registry.json`](assets/registry.json): model asset registry.
- [`docs/`](docs/): Markdown used by the website documentation.

## License

Wfloat is [MIT licensed](LICENSE). Models and third-party components have their own licenses; see the [model catalog](https://wfloat.com/models) and bundled license notices.

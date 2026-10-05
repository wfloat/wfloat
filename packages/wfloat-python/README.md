# Wfloat for Python

The Wfloat SDK for on-device inference in Python on macOS, Windows, and Linux. Supports language models, text-to-speech, speech-to-text, and voice activity detection.

## Install

```sh
python -m pip install wfloat
```

Requires Python 3.9 or newer. Platform wheels include the native runtime. The API is synchronous; your application handles microphone capture and audio playback.

[Installation details](https://wfloat.com/docs/how-to/installation?platform=python) · [Models and examples](https://wfloat.com/models)

## Example

```python
from wfloat import load_language_model

with load_language_model("HuggingFaceTB/SmolLM2-360M-Instruct") as model:
    result = model.generate(
        [{"role": "user", "content": "Hello!"}],
        max_tokens_per_round=128,
    )
    print(result.text)
```

The first load downloads the model files; later loads reuse cached files.

## Documentation

- [Language model](https://wfloat.com/docs/reference/language-models?platform=python)
- [Text to speech](https://wfloat.com/docs/reference/text-to-speech?platform=python)
- [Speech to text](https://wfloat.com/docs/reference/speech-to-text?platform=python)
- [Voice activity detection](https://wfloat.com/docs/reference/voice-activity-detection?platform=python)
- [Model management](https://wfloat.com/docs/reference/model-management?platform=python)

For local development, see [CONTRIBUTING.md](https://github.com/wfloat/wfloat/blob/main/packages/wfloat-python/CONTRIBUTING.md).

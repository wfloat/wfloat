# Contributing

`wfloat` is the Python client for `wfloat-tts`, Wfloat's on-device text-to-speech
model.

Product context:

- Homepage: https://wfloat.com
- Docs: https://docs.wfloat.com
- Model card and samples: https://huggingface.co/Wfloat/wfloat-tts
- Web package: https://github.com/wfloat/wfloat-web
- React Native package: https://github.com/wfloat/react-native-wfloat

This repo should stay focused on the Python experience.

## Prerequisites

- Python 3.9+

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install setuptools wheel build twine
```

Install `wfloat`:

```bash
python3 -m pip install -e .
```

That also installs the matching `wfloat-core` runtime dependency in normal
release installs. In this monorepo, local development can point at a freshly
built `wfloat-core` shared library with `WFLOAT_CORE_LIBRARY`.

## Build release artifacts

```bash
rm -rf build dist
python3 -m build
```

That produces:

- `dist/*.whl`
- `dist/*.tar.gz`

## Tests

Unit tests do not require native runtime binaries:

```bash
PYTHONPATH=python python3 -m unittest discover -s tests -v
```

You can also run a smoke check:

```bash
python3 -c "import wfloat, wfloat_core; print(wfloat.__version__, wfloat_core.get_library_path())"
```

## CI

CI:

- builds pure Python artifacts once
- installs those artifacts on each target platform
- relies on normal dependency resolution for `wfloat-core`
- runs the unit test suite and an integration smoke test

## Notes for changes

- Keep docs short and user-facing.
- Describe this package as the Python way to run `wfloat-tts` locally.
- If voices, emotions, or examples change, check the model card and docs first.

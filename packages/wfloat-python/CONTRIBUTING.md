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

Release wheels bundle the matching `wfloat-core` native runtime inside the
`wfloat` package. In this monorepo, local development can point at a freshly
built runtime shared library with `WFLOAT_CORE_LIBRARY`.

## Build release artifacts

```bash
rm -rf build dist
python3 -m build
```

That produces platform-specific release artifacts:

- `dist/*.whl`
- `dist/*.tar.gz`

## Tests

Unit tests do not require native runtime binaries:

```bash
PYTHONPATH=python python3 -m unittest discover -s tests -v
```

You can also run a smoke check:

```bash
python3 -c "import wfloat; from wfloat import _core; print(wfloat.__version__, _core._load_core_library())"
```

## CI

CI:

- runs the unit test suite without native runtime binaries
- builds platform wheels with the bundled `wfloat-core` native runtime
- smoke-loads the bundled native runtime from each built wheel

## Release

Publish Python with the `wfloat-v*` tag. The publish workflow builds and tests
all supported platform wheels before uploading `wfloat` to PyPI.

## Notes for changes

- Keep docs short and user-facing.
- Describe this package as the Python way to run `wfloat-tts` locally.
- If voices, emotions, or examples change, check the model card and docs first.

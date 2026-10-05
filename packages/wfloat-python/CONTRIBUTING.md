# Contributing

`wfloat` is the synchronous Python SDK for local language, TTS, STT and VAD models.

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
python3 -m pip install setuptools wheel build twine numpy pytest "pydantic>=2,<3"
```

Install `wfloat`:

```bash
python3 -m pip install -e .
```

Release wheels bundle the matching `wfloat-core` native runtime inside the
`wfloat` package. In this monorepo, local development can point at a freshly
built runtime shared library with `WFLOAT_CORE_LIBRARY`.
The structured LLM runtime also uses `WFLOAT_LLM_LIBRARY`; both libraries are
built by the package's wheel build.

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
PYTHONPATH=python python3 -m pytest tests -q
```

For real inference tests, predownload the registry's SmolLM2-360M, wfloat-tts,
Whisper tiny.en, English streaming Zipformer, and Silero models. Set
`WFLOAT_TEST_MODEL_CACHE` to that cache, `WFLOAT_TEST_TTS_CACHE` to the same cache,
`WFLOAT_TEST_GGUF` to the SmolLM2 GGUF, and both library paths above. Native tests
skip when their fixtures are unavailable; unit tests use deterministic backends
to exercise failures, scheduling and cancellation.

For Gemma 3 1B, the opt-in test below downloads and verifies both native GGUF
shards and accompanying registry documents, generates text, unloads, and reloads
with network access disabled. Use an empty cache directory to exercise the
initial public download. The existing structured native bridge must be available;
no runtime rebuild is needed when it already supports Gemma 3.

```bash
WFLOAT_TEST_GEMMA_CACHE="$PWD/out/gemma-public-smoke" \
WFLOAT_LLM_LIBRARY=/path/to/libwfloat-python-llm.dylib \
PYTHONPATH=python python3 -m pytest tests/test_gemma_shards.py -q -s
```

The public API remains `load_language_model("google/gemma-3-1b-it")`, with a
2048-token default context and the GGUF's embedded chat template. All assets stay
cached after unload; `delete_model_assets` removes them once no model holds a lease.

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

Publish Python with the `wfloat-python-v*` tag. The publish workflow builds and
tests all supported platform wheels before uploading `wfloat` to PyPI.

## Notes for changes

- Keep docs short and user-facing.
- Keep ordinary inference synchronous and streams lazy. Do not add audio-device capture/playback or mandatory Pydantic dependencies.
- Preserve inline callback exceptions, cancellation outcomes and ownership of returned NumPy samples.
- If voices, emotions, or examples change, check the model card and docs first.

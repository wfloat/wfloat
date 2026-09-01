# wfloat

Wfloat monorepo for shared native infrastructure, backend integrations, and
platform SDKs.

## Docs

Private model notes may live outside this public repo in local development
checkouts. When present, the short reference is expected at
`../docs/MODELS.md`.

## Top-Level Layout

```text
wfloat/
  CMakeLists.txt
  examples/
  native/wfloat-core/
  packages/
  tools/onnxruntime-build/
  vendor/
```

`tools/onnxruntime-build/` contains Wfloat's independent, public system for
building ONNX Runtime C and C++ artifacts across the platforms supported by
the vendored Sherpa integration. SDK builds consume only explicitly published,
SHA-pinned artifacts; the builder itself never publishes them.

## Current Native Status

- `native/wfloat-core/` has the first shared TTS ABI draft
- `vendor/sherpa-onnx/` is wired into the top-level CMake build
- Linux `wfloat-core-shared` builds successfully and can be loaded by the
  Python wrapper through `WFLOAT_CORE_LIBRARY`

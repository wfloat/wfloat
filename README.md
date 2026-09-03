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

[`tools/onnxruntime-build/`](tools/onnxruntime-build/README.md) builds the ONNX
Runtime C and C++ artifacts used by Wfloat and Sherpa. Consumers select
immutable published artifacts with reviewed URL and SHA-256 pins.

## Current Native Status

- `native/wfloat-core/` has the first shared TTS ABI draft
- `vendor/sherpa-onnx/` is wired into the top-level CMake build
- Linux `wfloat-core-shared` builds successfully and can be loaded by the
  Python wrapper through `WFLOAT_CORE_LIBRARY`

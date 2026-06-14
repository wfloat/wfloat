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
  vendor/
```

## Current Native Status

- `native/wfloat-core/` has the first shared TTS ABI draft
- `vendor/sherpa-onnx/` is wired into the top-level CMake build
- Linux `wfloat-core-shared` builds successfully and can be loaded by the
  Python wrapper through `WFLOAT_CORE_LIBRARY`

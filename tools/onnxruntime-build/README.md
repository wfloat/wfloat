# Wfloat ONNX Runtime artifact builder

Build and validate the ONNX Runtime C and C++ packages used by Wfloat and
Sherpa. `source-lock.json` pins each supported version to an exact Microsoft
source commit.

Run commands from the public Wfloat repository root.

## Use

```sh
./tools/onnxruntime-build/onnxruntime-build list targets
./tools/onnxruntime-build/onnxruntime-build list targets --json
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd --plan
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd --version 1.29.0 --jobs 4
./tools/onnxruntime-build/onnxruntime-build validate wasm-static_lib-simd path/to/archive.zip
```

`--plan` prints the resolved Microsoft commands without building. `build`
packages and validates its output. `validate` checks an existing archive. Use
`--help` for all options.

A build refuses uncommitted builder or workflow changes because the first 12
characters of the Wfloat commit identify its output. The target list marks a
target `verified` only after Wfloat accepts completed artifact evidence.

## Publication

Archive names contain the target family, ONNX Runtime version, and Wfloat
builder commit:

```text
onnxruntime-<family>-<version>-<12-character-builder-commit>.zip
```

Local builds, pull requests, and manual workflow runs do not publish. After a
push to `main`, each family workflow publishes only the archives that it built
and validated. Published objects are immutable. Consumers adopt an archive in
a separate change that pins its URL and SHA-256.

Archives include Microsoft's `LICENSE` and `ThirdPartyNotices.txt`. The builder
uses the repository's [MIT license](../../LICENSE).

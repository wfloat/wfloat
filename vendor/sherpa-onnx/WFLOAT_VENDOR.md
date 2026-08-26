# Wfloat Vendor Notes

This directory is a source import of upstream `k2-fsa/sherpa-onnx`, not a git
submodule.

- Upstream: https://github.com/k2-fsa/sherpa-onnx
- Imported commit: `1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911`
- Upstream tag: `v1.13.6`
- Previous imported commit: `ee398fa98fde44c2a4cccdea8153cdfb72074a42`
- Import date: 2026-08-26

The intentional Wfloat overlay adds the Wfloat TTS model, text preparation,
C API, and JNI integration. It also preserves Wfloat's combined browser speech
build and custom ONNX Runtime Web dependency, React Native Android staging, and
the flat iOS XCFramework layout consumed by the package.

Keep package-facing integration outside this directory when practical. Refresh
this import semantically so these build contracts remain intact as upstream
APIs and layouts change.

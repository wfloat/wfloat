# Wfloat Vendor Notes

This directory is a selective source import of upstream
`k2-fsa/sherpa-onnx`, not a git submodule. The imported commit tracks the
upstream runtime baseline; unrelated bindings, examples, packaging, and
workflow changes are not mirrored automatically.

- Upstream: https://github.com/k2-fsa/sherpa-onnx
- Imported commit: `9e6bc2f2b1db2cc9024e97886e8debf589e6d6a0`
- Nearest upstream tag: `v1.13.6`
- Previous imported commit: `1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911`
- Import date: 2026-08-28

The intentional Wfloat overlay adds the Wfloat TTS model, text preparation,
C API, and JNI integration. It also preserves Wfloat's combined browser speech
build and custom ONNX Runtime Web dependency, React Native Android staging, and
the flat iOS XCFramework layout consumed by the package.

Keep package-facing integration outside this directory when practical. Refresh
this import semantically so these build contracts remain intact as upstream
APIs and layouts change.

Web STT integration also retains the actual audio frame count for Whisper
segment-only timestamps, independently of attention collection. Upstream's
trailing-segment duration fallback otherwise receives zero frames in that mode.

Web VAD adds four C-linkage exports in the combined speech WASM entrypoint:
`WfloatCreateVadScorer`, `WfloatDestroyVadScorer`, `WfloatResetVadScorer`, and
`WfloatScoreVadFrame`. This score-only Silero bridge owns a `VadModel`, calls
`Compute` once per 512 new 16 kHz samples, and retains only the 64-sample left
context required by v5 (zero context for v4). Reset clears recurrent state and
context. It never creates a `VoiceActivityDetector`, segment queue, or circular
audio buffer, and applies no duration/threshold policy. Creation returns null,
reset returns 0, and scoring returns NaN on recoverable native errors; runtime
aborts remain fatal. Inference failure poisons the scorer until reset. These
additive browser exports leave existing Sherpa C API layouts unchanged.

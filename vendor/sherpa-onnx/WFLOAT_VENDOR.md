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

Kitten metadata version 8 has a local frontend/style/tail overlay; see
[Kitten 0.8 contract and evidence](WFLOAT_KITTEN_08.md). It accepts
raw text and performs pinned upstream normalization/chunking internally. The
Web adapter is wired; native/WASM frontend differential tests and rebuilt
Nano/Mini WASM smokes pass. Device qualification remains separate. Other
Kitten versions retain their previous behavior.

The iOS build pins the published ONNX Runtime 1.18.1 static XCFramework and
checks SHA-256 for downloaded and cached archives. This replaces 1.17.1, whose
ONNX domain-version validation rejects Kitten's `ai.onnx.ml` opset-5 import.
Version selection is refreshed even on cache hits. The existing flat-library
layout and iOS 13 engine target are retained; no model/SDK changes or validation
bypass are involved. Archive verification and binary minimums are documented in
[the Kitten integration notes](WFLOAT_KITTEN_08.md#ios-onnx-runtime-compatibility).

### VITS session compatibility with ORT 1.18.1

The local `offline-tts-vits-session-options.h` overlay disables memory-pattern
reuse for VITS sessions only when the linked runtime reports exactly `1.18.1`.
Both filesystem and asset-manager constructors apply it before session creation.
Graph optimization, the CPU arena, model assets, validation, and other model
families retain their existing behavior. Other ORT versions are unchanged.

The trigger was repeated generation with the unchanged LibriTTS-high export:
the first call succeeded, but subsequent calls failed at `Reshape_5227` or an
upstream `GatherElements` node, including when repeating the same speaker.
Durations can change with input values and random samples despite identical
input shapes. A six-call `903,903,0,903,0,903` direct-runtime probe passed on
ORT 1.17.1 and on ORT 1.18.1 with memory patterns disabled; ORT 1.18.1 with
default, Basic, or Extended graph optimization failed on reuse. This isolates
memory-pattern reuse as the trigger, not the precise underlying kernel defect.
The rebuilt public SDK passed twelve repeated/mixed-speaker calls across initial
load and cached reload. To reproduce, load LibriTTS-high and generate the same
sentence with speakers `903,903,0,903,0,903`, checking finite, nonempty audio;
unload, load from cache, and repeat. Use the unmodified model and default graph
optimization/CPU arena settings. Machine-local build and qualification reports
are excluded from the public source tree.

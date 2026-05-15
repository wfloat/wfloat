# wfloat-core

`wfloat-core` is the Wfloat-owned shared native layer.

It exists to provide one Wfloat-native contract above multiple backend
implementations such as `sherpa-onnx` and `llama.cpp`.

## Intended Responsibilities

- common native API surface
- capability routing
- model registry and metadata schema
- backend selection policy
- lifecycle/load/unload orchestration
- validation of staged model assets
- shared error/state model

## Non-Responsibilities By Default

- blocking download transport
- browser-specific network code
- raw platform/device probing
- pretending all backends share one internal execution model

## Expected Shape

Over time this directory should grow into:

- `include/`
- `src/`
- tests
- build definitions

Those pieces are intentionally not overcommitted yet until the first public
native surface is chosen.

## First Concrete Target

The first concrete shared contract should be generic TTS orchestration above
`sherpa-onnx`:

- one-shot synthesis
- dialogue synthesis
- structured audio/timeline results
- progress/cancel plumbing

Current draft native surface:

- [include/wfloat-core/wfloat_stt.h](/home/mitch/dev/slop_fork/wfloat/native/wfloat-core/include/wfloat-core/wfloat_stt.h:1)
- [include/wfloat-core/wfloat_tts.h](/home/mitch/dev/slop_fork/wfloat/native/wfloat-core/include/wfloat-core/wfloat_tts.h:1)
- [src/wfloat_stt.cc](/home/mitch/dev/slop_fork/wfloat/native/wfloat-core/src/wfloat_stt.cc:1)
- [src/wfloat_tts.cc](/home/mitch/dev/slop_fork/wfloat/native/wfloat-core/src/wfloat_tts.cc:1)
- [CMakeLists.txt](/home/mitch/dev/slop_fork/wfloat/native/wfloat-core/CMakeLists.txt:1)

The STT draft now includes both:

- offline `transcribe(...)`
- session-style STT ABI for streaming-capable model families

Current STT implementation state:

- offline families: Whisper, Moonshine, Parakeet CTC, Parakeet TDT
- first streaming family: Zipformer transducer sessions via sherpa's online
  recognizer C API
- Linux shared wrapper path uses vendored sherpa in `BUILD_SHARED_LIBS=ON`
  mode so `libwfloat-core.so` resolves through
  `libsherpa-onnx-c-api.so` + `libonnxruntime.so`, matching the upstream
  packaging strategy that works for both offline and streaming recognizers

That does not mean every backend family is implemented yet. The intent is to
keep the native contract aligned with the web/package direction while new
streaming families are brought up incrementally.

That work should stay separate from:

- playback helpers
- browser worker scheduling
- platform download transport

## Current Build Assumption

On Linux, the top-level [CMakeLists.txt](/home/mitch/dev/slop_fork/wfloat/CMakeLists.txt:1)
forces vendored sherpa into shared-library mode when `WFLOAT_BUILD_CORE` is on.
That keeps the `wfloat-core` shared wrapper aligned with upstream sherpa's
working `libsherpa-onnx-c-api.so` packaging rather than embedding the static
onnxruntime stack inside a second shared object.

The native build now defines both:

- `wfloat-core` as a static library target
- `wfloat-core-shared` as a shared library target with output name
  `wfloat-core`

The shared target exists so wrappers such as Python can load the ABI through
`ctypes` without inventing a wrapper-specific native build.

On Linux, the top-level build now enables PIC for the vendored native graph so
`wfloat-core-shared` can link against static backend libraries without forcing
the entire sherpa dependency stack into shared-library mode.

# Building native release artifacts

These are publisher commands for a full Wfloat source checkout. npm consumers
use the packaged Android shared libraries and iOS xcframeworks; they do not need
the vendor source tree, CMake, or the publisher scripts. Both legacy `Wfloat` and
new `WfloatNext` native modules remain available.

## Build and stage

Run from `packages/react-native-wfloat` after installing repository dependencies:

```sh
yarn rn:build-natives all
yarn rn:stage-natives all
yarn prepare
yarn package:verify
npm pack
```

Use `ios` or `android` instead of `all` to work on one platform. Builds require
matching source revisions and native speech/ONNX Runtime dependencies. macOS and
Xcode are required for iOS. Android requires the SDK/NDK, CMake and Ninja; configure
`ANDROID_HOME`, `ANDROID_NDK_HOME`, and optionally `CMAKE_BIN`/`NINJA_BIN`.
`WFLOAT_BUILD_JOBS` controls parallelism.

`WFLOAT_ANDROID_ABIS` accepts comma- or space-separated ABI names. The default is
`arm64-v8a armeabi-v7a x86_64 x86`. A subset is useful for local iteration, but the
release preflight requires all four ABIs. Restricting a build does not remove
other staged ABIs or certify that their binaries are current.

## iOS

`yarn rn:build-ios-next` builds and stages the combined
`wfloat-core-llm.xcframework`. `yarn rn:build-ios-llm` remains a compatibility alias
for the combined build. The artifact contains the legacy LLM C API, new common
runtime, native schema validator, and one matching llama/common/ggml build. The
separate matching Sherpa and ONNX Runtime frameworks supply speech inference.

The combined build outputs are under `ios/build/next-runtime`; staging requires
the `wfloat-next/NextRuntime.h` header in both device and universal simulator
slices. Staging never falls back to the obsolete legacy-only output directory.
The platform script builds arm64 device and arm64/x86_64 simulator slices, then
stages the xcframework only after all slices succeed.

## Android

`rn:build-natives android` builds the speech dependencies and legacy LLM bridge,
stages speech/ORT for the next runtime's linker, then invokes the Android-owned
`android/next-jni/build-and-stage.sh` for each selected ABI. For an incremental
next-only build after dependencies are already staged:

```sh
yarn rn:build-android-next arm64-v8a
```

That script accepts `WFLOAT_SHERPA_DEPS_DIR` and `WFLOAT_ORT_HEADERS` for existing
matching dependency sources and headers. It builds the real raw VAD implementation;
an opaque C API detector is not a substitute for probability scoring.

`rn:stage-natives android` requires both bridge outputs before copying artifacts.
It stages `libwfloat-llm-jni.so` and `libwfloat-next-jni.so` alongside Sherpa/ORT.
The internal `stage-natives.sh android --speech-only` step preserves existing
bridges while updating their speech dependencies. Full staging preflights all
selected ABIs before changing their speech libraries.

Consumers use staged libraries by default. The Gradle
`wfloatNextBuildFromSource=true` switch is a source-checkout development option,
not an npm installation requirement.

## Verify the distribution

CI strips Android libraries with the NDK's `llvm-strip --strip-unneeded` before
packaging, verifying that dynamic exports, dependency metadata, and build IDs
remain unchanged. Debug symbols are retained separately in the
`wfloat-rn-debug-symbols-<abi>` workflow artifacts for 90 days. Download those
artifacts before they expire if longer retention is needed.

The compressed npm tarball must fit our 180 MiB publishing budget. This is a
conservative project limit, not npm's documented maximum; the upload request
also contains base64 overhead. Android and iOS consumer builds use that same
tarball before publication.

From the React Native package directory in a full source checkout, run
`yarn test:portable` for the shared contract and native-adapter regression tests.
The runner reuses the checked-in web tests and repository dependencies; its
header documents the Hermes runtime requirement. It needs no outer `tmp` fixtures.

`npm pack` runs a native-artifact presence/symlink preflight through `prepack`.
`yarn package:verify` also checks npm's actual dry-run file manifest for generated
JS/types, both Codegen modules, platform binaries, and accidental test/build or
internal-document inclusion. The manifest audit suppresses lifecycle execution (including npm versions that
run `prepare` despite `--ignore-scripts`). It does not build missing artifacts or validate
binary symbol/ABI compatibility; run consumer builds and device inference tests
for that evidence.

The tarball excludes C++ implementation sources, source-only JNI builders, build
outputs, tests, and internal implementation-status notes. It includes public
platform sources, generated Codegen, JavaScript/types, staged native artifacts,
this build guide, and third-party notices. The release build must stage artifacts
from a consistent source revision; the preflight cannot detect stale binaries.

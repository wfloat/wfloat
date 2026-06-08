# Contributing

## Local example config

Before running the example app, create a local config file for untracked developer-specific values:

```ts
// example/src/localConfig.ts
export const LOCAL_CONFIG = {
  modelId: 'your-model-id',
} as const;
```

This file is gitignored. Use it for values you need locally in the example app but do not want to commit, such as a model id.

## Repository structure

- The package itself lives at the repository root.
- The example app lives in [`example/`](./example) and is used to run the package on iOS and Android during local development.

## Getting started

Install dependencies from the repository root:

```sh
yarn
```

## Native artifacts

Native build artifacts are not tracked in git. Maintainers stage real native files into this package before running `npm pack` or `npm publish`.

Build native artifacts from `../../vendor/sherpa-onnx`, `../../vendor/llama.cpp`,
and `../../native/wfloat-core`:

```sh
yarn rn:build-natives
```

Copy the built iOS `.xcframework` directories and Android `.so` files into this package:

```sh
yarn rn:stage-natives
```

The staging step also normalizes the iOS `onnxruntime.xcframework` for React
Native publishing:

- removes the upstream macOS slice, because this package only vends iOS
  device and simulator artifacts
- keeps a single real `libonnxruntime.a` file per iOS slice, avoiding duplicate
  copies created from upstream symlink aliases
- updates the XCFramework `Info.plist` so Xcode and CocoaPods point at
  `libonnxruntime.a`

After staging, the expected iOS onnxruntime shape is:

```text
ios/onnxruntime.xcframework/
  ios-arm64/libonnxruntime.a
  ios-arm64_x86_64-simulator/libonnxruntime.a
```

There should not be a `macos-arm64_x86_64` slice or duplicate
`onnxruntime.a` files in the staged package directory.

Use platform arguments when you only need one side:

```sh
yarn rn:build-natives ios
yarn rn:stage-natives android
```

The iOS LLM runtime can also be rebuilt directly:

```sh
yarn rn:build-ios-llm
```

That writes `../../out/rn-llm-ios/wfloat-core-llm.xcframework`, which
`yarn rn:stage-natives ios` then copies into `ios/`.

Before publishing, verify the tarball contains the staged native files:

```sh
npm pack --dry-run --json
```

Confirm the dry-run output includes:

- `ios/onnxruntime.xcframework/**/libonnxruntime.a`
- `ios/sherpa-onnx.xcframework/**/libsherpa-onnx.a`
- `ios/wfloat-core-llm.xcframework/**/libwfloat-core-llm.a`
- `android/src/main/jniLibs/*/*.so`
- `ios/generated/**`
- `android/generated/**`
- `lib/**`

The older `install-android-jni-libs.sh` registry downloader is kept as a temporary maintainer fallback for refreshing Android `.so` files from a prebuilt archive.

### iOS native changes

Typical commands:

```sh
yarn prepare
cd example/ios
bundle exec pod install
cd ../..
yarn example ios
```

### Android local testing

The Android Emulator cannot reach host-only services through its own
`localhost` unless ADB forwards the ports. When testing the example app against
local Metro and the local model asset API, run:

```sh
adb reverse tcp:8081 tcp:8081
adb reverse tcp:4000 tcp:4000
```

If microphone permission is granted but STT or live VAD hears silence, check
`Extended controls > Microphone > Virtual microphone uses host audio input` in
the emulator, then restart the emulator if needed.

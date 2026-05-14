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

## Refreshing Android JNI libraries

The `install-android-jni-libs.sh` script is for maintainers of this package, not for application developers integrating the SDK.

Use it only when updating the Android native assets before publishing a new package release.

The script refreshes the native libraries under `android/src/main/jniLibs/<abi>`.

```sh
./install-android-jni-libs.sh
```

You can also pass an explicit version:

```sh
./install-android-jni-libs.sh 1.13.1
```

The installer downloads the combined Android archive from the Wfloat registry and copies the `.so` files into the matching ABI directories.

### iOS native changes

Typical commands:

```sh
yarn prepare
cd example/ios
bundle exec pod install
cd ../..
yarn example ios
```

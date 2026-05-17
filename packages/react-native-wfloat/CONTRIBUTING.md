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

Build native artifacts from `../../vendor/sherpa-onnx`:

```sh
yarn rn:build-natives
```

Copy the built iOS `.xcframework` directories and Android `.so` files into this package:

```sh
yarn rn:stage-natives
```

Use platform arguments when you only need one side:

```sh
yarn rn:build-natives ios
yarn rn:stage-natives android
```

Before publishing, verify the tarball contains the staged native files:

```sh
npm pack --dry-run
```

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

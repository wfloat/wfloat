# React Native Wfloat consumer fixture

This app is a minimal installed-package fixture for `@wfloat/react-native-wfloat`.

It should behave like a user app:

- The package under test is installed from a packed tarball by
  `scripts/consumer-build-smoke.mjs`.
- React Native autolinking should discover the package from `node_modules`.
- The app should not reach back into the local library checkout.
- The app should not run library codegen from local source.

Keep this fixture boring. It exists to catch packaging, autolinking, CocoaPods,
Gradle, and native link/build regressions before publishing.

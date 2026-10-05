# Install Wfloat

In your React Native application:

```sh
npm install @wfloat/react-native-wfloat
cd ios && pod install
```

Rebuild the native app after installing. Android uses autolinking. Expo Go cannot load Wfloat's native module; use a native development build. The tested development baseline is React Native 0.76.5 with Hermes and the New Architecture.

For microphone input, add `NSMicrophoneUsageDescription` to the iOS app's `Info.plist` and `android.permission.RECORD_AUDIO` to the Android app's manifest. Wfloat requests microphone permission when capture starts. Playback alone does not require microphone permission.

**Next: [choose a model](https://wfloat.com/models)** and follow its React Native example. See [model management](../reference/model-management.react-native.md) for downloads and cleanup.

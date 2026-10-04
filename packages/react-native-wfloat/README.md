# @wfloat/react-native-wfloat

On-device text generation, text-to-speech, speech recognition and voice activity detection for React Native. Native modules require a native app build; Expo Go is not supported.

## Install

```sh
npm install @wfloat/react-native-wfloat
cd ios && pod install
```

Android uses React Native autolinking. Development/testing baseline: React Native 0.76.5 with Hermes and the New Architecture. Physical-device audio routes and background behavior require device testing before release.

## Load and retain models

```ts
import { downloadModel, loadTextToSpeech, deleteModelAssets } from '@wfloat/react-native-wfloat';

const controller = new AbortController();
await downloadModel('wfloat/wfloat-tts', {
  signal: controller.signal,
  onProgress(event) {
    if (event.phase === 'downloading') {
      console.log(event.progress, event.bytesPerSecond, event.estimatedTimeRemainingMs);
    }
  },
});
const speech = await loadTextToSpeech('wfloat/wfloat-tts');
// Later: await speech.unload(); // release the model, retain downloaded assets
// await deleteModelAssets('wfloat/wfloat-tts'); // remove its private assets
```

Loaders also download missing assets and accept `signal` and `onProgress`. Verified cached assets skip the downloading phase. Files live in durable app-private storage excluded from backups. Shared downloads retain separate caller cancellation; shared runtime assets are kept when deleting one model. Separate loaded model instances have independent ownership.

## Speech generation and playback

```ts
const playback = speech.speak('Hello.', {
  onPlayback(event) { console.log(event.state, event.highlight); },
});
// playback.pause(); playback.resume(); playback.cancel();

const generation = speech.generate('Audio your application can also consume.');
const result = await generation.result();
console.log(result.audio.samples, result.audio.sampleRate, result.timeline);
generation.speak({ onPlayback: event => console.log(event.state) });
// After every use: generation.dispose();
```

`generateDialogue()` and `speakDialogue()` accept segments with text and optional voice/emotion/speed settings. Generation retains audio for replay and `result()`; direct speech releases played audio. Call `unload()` when finished with the model.

## Text generation

```ts
import { loadLanguageModel } from '@wfloat/react-native-wfloat';

const model = await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct');
const generation = model.generate([{ role: 'user', content: 'Hello!' }], {
  maxTokensPerRound: 128,
  onText: text => console.log(text),
});
const result = await generation.result();
console.log(result.text, result.stopReason);
// generation.cancel(); // stop ongoing work; tools receive its AbortSignal
await model.unload();
```

Tools, reasoning callbacks and structured output follow the redesigned web contracts. Structured output and tools cannot be combined in one request. Independent background generation jobs are not promised.

## Transcribe audio

```ts
import { loadSpeechToText } from '@wfloat/react-native-wfloat';

const stt = await loadSpeechToText('openai/whisper-tiny-en');
const transcription = stt.transcribe({ uri: 'file:///path/to/recording.wav' });
console.log((await transcription.result()).text);
// Also accepts { samples: Float32Array, sampleRate: number }, including TTS result.audio.
await stt.unload();
```

Wfloat decodes supported native audio formats and normalizes channels/sample rate. Android document-provider `content://` URIs require an accessible URI grant. Download remote audio in your application first.

## Live recognition and shared microphone

```ts
import { loadStreamingSpeechToText, loadVoiceActivityDetection,
  createMicrophoneCapture } from '@wfloat/react-native-wfloat';

const stt = await loadStreamingSpeechToText('k2-fsa/streaming-zipformer-en');
const vad = await loadVoiceActivityDetection('snakers4/silero-vad');
const transcript = await stt.createSession({
  onTranscript: event => console.log(event.id, event.text, event.isFinal),
  onError: error => console.error(error, error.partialResult),
});
const detection = await vad.createSession({
  returnAudio: true,
  onSpeechEnd: segment => console.log(segment.startMs, segment.endMs, segment.audio),
  onError: error => console.error(error, error.partialResult),
});
const mic = createMicrophoneCapture({
  voiceProcessing: true,
  backgroundBehavior: 'pauseUntilResumed',
  onCaptureState: event => console.log(event.state),
});
await transcript.attachMicrophone(mic);
await detection.attachMicrophone(mic);
await mic.start(); // Call from your recording control; prompts if necessary.
// After returning from background: await mic.start();
// Finish: await mic.stop(); await transcript.finish(); await detection.finish();
// Then unload both models.
```

For one consumer, use `await session.startMicrophone(options)` instead. `session.finish()` stops its owned mic; shared captures remain explicitly owned by your application. `mic.stop()` is terminal. Sessions can also accept raw audio through `push()`; acceptance is not a backpressure guarantee. STT warns when unprocessed audio accumulates; configure `maxBufferedAudioMs` on the session if your app requires a hard limit.

`vad.detect(audio, { returnAudio: true }).result()` retains completed clips in its result. Live VAD delivers clips through `onSpeechEnd`; its final result contains timing ranges without accumulating all session audio.

## Mobile audio policy

Microphone and speech playback accept `backgroundBehavior`:

- `pauseUntilResumed` (default): pause when backgrounded; resume explicitly.
- `pauseAndAutoResume`: pause when backgrounded and resume on foreground return.
- `continue`: opt into background capture/playback with native configuration below.

OS audio interruptions require explicit resume. A surviving capture/session retains state; captured-audio time excludes gaps. Process termination destroys live handles. JavaScript callback delivery may be delayed while backgrounded.

Playback accepts `audioFocus`: `interruptOthers` (default), `duckOthers`, or `mixWithOthers`. Microphone `voiceProcessing` defaults to false; enabling it requests native echo/noise processing. Unsupported processing warns and continues capture. It does not implement turn taking or TTS interruption.

Simultaneous playback must use the same `audioFocus`. If starting or resuming speech conflicts with playback already active, that speech reports `failed` through `onPlayback`; existing playback continues unchanged. Loaded models, generation without playback, prepared playback and paused handles do not cause conflicts. An active playback retains its focus policy through temporary buffering gaps until paused or ended.

### Permissions and background setup

- iOS recording requires `NSMicrophoneUsageDescription` in the app's Info.plist. Continued background audio also requires `UIBackgroundModes` containing `audio`.
- Android recording requires `RECORD_AUDIO`; Wfloat requests runtime permission when capture starts. Continued background audio additionally requires the relevant foreground-service declaration/permissions. Copy applicable entries from [the manifest example](android/AndroidManifest.background.example.xml). A foreground-service notification is shown while active.
- Foreground-only apps do not need background capabilities. Requesting `continue` without required setup fails clearly.

Background recording must be started while the app is eligible to acquire microphone access. Hardware routes, interruptions and OS restrictions still apply; no permanent background execution or restoration after termination is guaranteed.

## Legacy API and development

Earlier `loadTtsModel`, `loadSttModel` and `loadVadModel` exports remain available during migration; their behavior is documented in [the legacy guide](LEGACY_API.md). Avoid mixing legacy and redesigned audio controllers in the same workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md) for build setup. The example app contains explicit native smoke-test controls. Android emulator audio requires host microphone input enabled; emulator performance is not a physical-device benchmark.

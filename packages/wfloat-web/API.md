# Web SDK: model-instance APIs

The current entry points are `loadTextToSpeech`, `loadLanguageModel`,
`loadSpeechToText`, `loadStreamingSpeechToText`, `downloadModel`, and
`deleteModelAssets`. VAD is unchanged. Existing
`loadTtsModel`/`loadLlmModel`/`loadSttModel` exports remain available during migration; their
legacy singleton worker behavior is separate from these APIs.

The model tables describe IDs integrated in this branch. Publication and platform qualification are ongoing; inclusion is not a claim of completed testing on every platform.

## Download, load, unload, delete

```ts
import { downloadModel, loadLanguageModel, deleteModelAssets } from '@wfloat/wfloat-web';

const id = 'HuggingFaceTB/SmolLM2-360M-Instruct';
const controller = new AbortController();
await downloadModel(id, {
  signal: controller.signal,
  persistence: 'auto', // 'request' permits a browser prompt; 'off' skips the request.
  onProgress(event) {
    if (event.phase === 'downloading') {
      console.log(event.progress, event.bytesPerSecond, event.estimatedTimeRemainingMs);
    }
  },
});
const model = await loadLanguageModel(id, { contextSize: 2048 });
await model.unload(); // Keeps saved model files; safe to repeat.
await deleteModelAssets(id); // Removes private files and partials; keeps shared assets.
```

Predownload is optional. Loading downloads missing files. Progress phases are
`checking`, `downloading`, `loading`, `ready`; download-only calls omit loading,
and a local cache hit omits downloading. Unknown measurements are absent.
Progress is aggregated across the bytes still needed when the caller joins.

Assets are stored durably in IndexedDB chunks and verified against registry
SHA-256 values. Partial downloads resume when supported by the server. Concurrent
callers share transfers; aborting one caller does not cancel other users of the
same transfer. Web Locks coordinate writers across tabs; transactional guards
prevent corrupt writes without Web Locks. Browser eviction remains possible.
Storage failures reject; there is no silent memory-only fallback. Persistence
permission denial alone is not a storage failure.

Deleting during a pending download/load makes affected operations reject with
`ModelAssetsDeletedError`. Already loaded model instances keep their owned bytes.
A load signal is detached after successful initialization. Abort pending
load/download promises with a caller-owned signal; unload completed models.

## Language generation

| Model IDs | Behavior |
| --- | --- |
| `HuggingFaceTB/SmolLM2-360M-Instruct` | Existing text-generation model. |
| `Qwen/Qwen3-0.6B`, `Qwen/Qwen3-1.7B` | Embedded thinking template; reasoning enabled unless explicitly disabled. |
| `Qwen/Qwen3-4B` | Same thinking behavior; limited smoke qualification only (see below). |
| `google/gemma-3-270m-it`, `google/gemma-3-1b-it` | Embedded Gemma text-chat template. |

Qwen 4B has passed bounded Web, Python and RN iOS/Android generation and
cached-reload checks at context 2048 with reasoning disabled. These checks do
not qualify physical-device performance, reasoning, tools, structured output
or long-context behavior for 4B.

Qwen and Gemma default to a 2048-token context. Model files, quantization and shard
layout are selected internally; there is no public quantization or shard selector.
Larger models need more memory even when their downloads are split into shards.
Qwen sampling defaults follow the reasoning mode; explicit sampling options take
precedence. Use `reasoning: false` to disable thinking and bound generation with `maxTokensPerRound`.

`loadLanguageModel('google/gemma-3-1b-it')` uses the embedded Gemma chat template.
Its GGUF shards are downloaded, verified, and loaded together internally; callers
do not select shards or quantization. Download progress includes accompanying
Gemma terms, prohibited-use policy, notice, and provenance files. Gemma model
use/distribution is subject to those model-specific terms; the SDK license is
unchanged. Browser memory requirements exceed the approximately 806 MB of weights.
Private browsing can impose a smaller storage quota than its reported estimate;
a quota failure rejects the load with `AssetStorageError` and retains the browser
error as its cause.

```ts
import { loadLanguageModel, type Message } from '@wfloat/wfloat-web';
const model = await loadLanguageModel('HuggingFaceTB/SmolLM2-360M-Instruct');
const messages: Message[] = [{ role: 'user', content: 'Explain photosynthesis.' }];
const generation = model.generate(messages, {
  maxTokensPerRound: 256,
  onRoundStart: ({ roundIndex }) => console.log('Round', roundIndex),
  onText: fragment => appendAnswer(fragment),
  onReasoning: fragment => appendReasoning(fragment),
});
const result = await generation.result();
messages.push(...result.newMessages);
console.log(result.text, result.stopReason, result.usage, result.durationMs);
```

`generate` returns its handle before notification callbacks run. `finished` is a
`Promise<void>` and `result()` returns the same settled result on repeated calls.
`cancel()` signals tools and resolves a fixed partial result with
`stopReason: 'cancelled'`. It is not pause/resume. Tools that ignore the signal may
still finish and emit late callbacks; cancellation cannot undo their side effects. Genuine operation failures
reject both observers with `GenerationError`, whose `cause` and `partialResult`
preserve diagnostics and recoverable history. Observing either promise is enough
to avoid duplicate unhandled-promise reports.

`result.text` is the latest round's ordinary text, not all rounds concatenated.
Reasoning is separate when the model has an explicit reasoning channel. Ordinary
pre-tool commentary still appears in `onText`. Returned assistant messages use
ordered parts; input assistant messages may also be strings. `newMessages` holds
only this operation's additions. Generated messages carry ISO UTC `createdAt`;
timestamps are not inserted into the model prompt. `usage` sums fully formatted
input tokens and generated tokens across rounds, including reasoning and tools.

One model instance queues whole operations FIFO, including tool waits and
corrections. Independent instances have independent contexts. **Do not await a
new generation on the same model from its own tool executor:** that queues behind
the operation waiting for the executor. Use a separate instance for nested work.

## Tools

```ts
import { defineTool } from '@wfloat/wfloat-web';
const weather = defineTool({
  description: 'Read current weather for a city',
  inputSchema: {
    type: 'object', properties: { city: { type: 'string' } },
    required: ['city'], additionalProperties: false,
  },
  async execute({ city }, { signal }) {
    const response = await fetch(`/weather?city=${encodeURIComponent(city)}`, { signal });
    if (!response.ok) throw new Error('Weather service unavailable');
    return await response.json();
  },
});
const generation = model.generate(messages, {
  tools: { weather },
  maxRounds: 20, // Default; inference passes, not individual tool calls.
  toolExecution: 'parallel', // Default: 'sequential'.
  maxConcurrentTools: 3, // Optional cap; only valid with parallel execution.
  toolExecutionTiming: 'immediate', // Or 'afterGeneration'.
  toolErrorBehavior: 'continue', // Default; 'stop' rejects on executor exceptions.
  onToolCall: ({ call }) => showRequested(call),
  onToolStart: ({ call }) => showRunning(call.id),
  onToolResult: ({ call, output }) => showCompleted(call.id, output),
  onToolError: ({ call, error }) => showFailed(call.id, error),
  onToolCancel: ({ call }) => showCancelled(call.id),
});
```

All tools in one operation must have executors, or all must be manual. Complete,
validated requests can start before the model finishes its round. Parallel result
callbacks arrive in completion order; history retains request order. Invalid
arguments and unknown tool names emit `onToolValidationError` and provide model
feedback without executing. Executor exceptions normally provide message-only
failure feedback; the model may choose another request. Wfloat never retries an
executor automatically. Non-JSON executor returns (`undefined`, cycles, class
instances, nonfinite numbers) are application errors and reject the operation.

Manual handling uses the same transformed, validated arguments:

```ts
import { defineTool, toolResult, type Message } from '@wfloat/wfloat-web';
const history: Message[] = [{ role: 'user', content: 'Weather in Boston?' }];
const tool = defineTool({ inputSchema: weather.inputSchema }); // No execute.
const turn = model.generate(history, { tools: { weather: tool } });
const result = await turn.result();
history.push(...result.newMessages);
for (const call of result.toolCalls) {
  const response = await lookupWeather(call.arguments.city);
  history.push(toolResult(call, response));
}
const next = model.generate(history, { tools: { weather: tool } });
```

For earlier manual execution, start jobs from `onToolCall` and retain them by call
ID. After `result()` resolves, reuse those jobs rather than executing its
`toolCalls` again. Wfloat does not await jobs returned from notification callbacks.
Pass `generation.signal` into application work if cancellation should propagate.
For an interrupted manual call, append the actual known outcome: `notExecuted`
only if never started, `outcomeUnknown` if started without a known result, or
`toolResult` for a known result. Replace an unknown record in your own history if
a late outcome becomes known. SDK results themselves do not update later.

## Structured output and schemas

```ts
const generation = model.generate([{ role: 'user', content: 'Return a short title.' }], {
  structuredOutput: {
    schema: {
      type: 'object', properties: { title: { type: 'string' } },
      required: ['title'], additionalProperties: false,
    },
    maxCorrectionAttempts: 0, // Default; no correction inference.
  },
  onRoundStart: () => clearAttemptPreview(),
  onText: fragment => appendAttemptPreview(fragment),
});
const { output } = await generation.result();
console.log(output?.title);
```

Llama.cpp constrains supported answer tokens; Wfloat validates the completed
value. The validation subset is documented in
[`native/wfloat-core/src/schema/README.md`](../../native/wfloat-core/src/schema/README.md).
Unsupported schema keywords fail explicitly. Some validation constraints cannot
be represented exactly by the grammar and remain post-generation checks.
Nonempty `tools` and `structuredOutput` cannot be combined in this release.
Reasoning support remains model/template-dependent.

A supported caller-installed Zod schema may be passed directly; Wfloat does not
install/import Zod. Conversion uses the schema's accepted-input shape; validation
uses the supplied parser, including refinements/transforms/defaults. Parsed values
reach executors, manual calls and `result.output`; raw model values stay in history.
See [`src/schema/README.md`](src/schema/README.md) for tested versions and limits.
Schema preflight runs in the worker before inference; unsupported schemas reject
the operation, rather than pretending a synchronous main-thread check occurred.

Ordinary validation exhaustion rejects with `GenerationError`. Expected early
stops retain text/history and return a validated output only when available.
Cancellation permits a short, bounded validation opportunity for complete JSON;
an uncooperative async refinement cannot hold Stop indefinitely. Late validation
never mutates the returned result. Correction rounds count toward `maxRounds`.
Use `onRoundStart` to reset streamed attempt previews before a correction.

## Bounds and context

`maxTokensPerRound` is optional; it counts all generated tokens in that pass.
`maxRounds` defaults to 20. `stopWhen({ messages, rounds, latestRound })` runs at a
round boundary after managed tools settle, before further inference.
`stopStrings` match ordinary answer text only, strip the marker, and can span token
fragments. Already accepted managed calls finish after a stop-string/token/context
boundary, but no further model round runs. Explicit cancellation does not wait
for uncooperative tools.

```ts
const needed = await model.countInputTokens(messages, { tools: { weather } });
if (needed >= model.contextSize) {
  // Compact/edit the application's history before generation.
}
```

Counts include the actual formatted template and tools; they do not run inference.
Context exhaustion returns `stopReason: 'contextLimit'` and capacity details.
Wfloat does not silently truncate or compact history. Prefix reuse is internal;
changes to formatted prefixes can require prefill again.

Optional sampling controls: `temperature`, `topP`, `topK`, `minP`,
`repetitionPenalty`, `presencePenalty`, `frequencyPenalty`, `seed`.
`reasoning` requests a mode where supported. Unsupported reasoning preferences
warn; unsupported tools/schema capabilities must not be silently ignored.

## Speech

Additional speech-generation IDs use the existing loader and `voiceId` option:

| Model ID | Language / voice selection |
| --- | --- |
| `rhasspy/piper-en_US-lessac-medium` | US English; voice 0. |
| `rhasspy/piper-en_US-amy-medium` | US English; voice 0. |
| `rhasspy/piper-en_US-ryan-medium` | US English; voice 0. |
| `rhasspy/piper-en_GB-alba-medium` | British English; voice 0. |
| `rhasspy/piper-de_DE-thorsten-medium` | German; voice 0. |
| `rhasspy/piper-fr_FR-siwis-medium` | French; voice 0. |
| `rhasspy/piper-en_US-libritts-high` | US English; speaker IDs 0–903. |
| `hexgrad/Kokoro-82M` | American/British English, Spanish, French, Hindi, Italian, Brazilian Portuguese and Mandarin; named voices or numeric IDs. Japanese excluded. |
| `KittenML/kitten-tts-nano-0.8` | English; eight named voices or IDs 0–7; 24 kHz output. |
| `KittenML/kitten-tts-mini-0.8` | English; eight named voices or IDs 0–7; 24 kHz output. |

Kokoro Japanese voices (`jf_*`, `jm_*`, numeric IDs 37–41) are rejected: the current
frontend routes Han characters through Chinese pronunciation. Piper/Kokoro/Kitten do not
support reference-audio voice cloning. Shared eSpeak data is downloaded internally.

Kitten voice IDs 0–7 map to `Jasper`, `Bella`, `Bruno`, `Luna`, `Hugo`, `Rosie`,
`Leo`, and `Kiki`. Kitten requires the updated 0.8 frontend runtime and accepts
at most 65,536 Unicode codepoints per synthesis call. Limited Web, Python and
RN iOS/Android smoke checks have passed for Nano and Mini. The iOS runtime
requires the bundled ONNX Runtime 1.18.1 update for these exports.
These checks do not establish broad platform or pronunciation-quality coverage.

```ts
import { loadTextToSpeech } from '@wfloat/wfloat-web';
const speech = await loadTextToSpeech('wfloat/wfloat-tts');
const playback = speech.speak('Hello there.', {
  voiceId: 0,
  onPlayback(event) {
    updatePlaybackState(event.state);
    highlight(event.highlight); // null during silence and after completion.
  },
});
playback.pause();
playback.resume();
playback.cancel();

const generation = speech.generate('Audio that I want to keep.');
const livePlayback = generation.speak({ onPlayback: updatePlayback });
for await (const chunk of generation.audio) {
  // chunk.audio.samples, chunk.audio.sampleRate, chunk.startMs, chunk.timeline
}
const result = await generation.result();
await generation.finished;
// result.audio.samples / sampleRate and result.timeline are plain data.
generation.dispose();
```

Direct speech uses bounded buffering and releases played audio. Generation retains
its audio so playback, replayable iteration and `result()` can coexist. Each
`generation.speak()` starts a separate playback handle from the beginning, without
waiting for the whole result. Cancelling that playback does not dispose its parent
generation. Disposing the parent stops its dependent playbacks and releases SDK
references; buffers already delivered to application code remain usable.

Sample arrays are borrowed and read-only by contract: do not mutate them or
transfer/detach their buffers. Use `samples.slice()` when you need an owned,
writable or transferable copy. Repeated `result()` calls reuse the assembled result.

```ts
speech.speakDialogue([
  { text: 'Hi.', voiceId: 0, pauseAfterMs: 200 },
  { text: 'Hello!', voiceId: 1 },
], { pauseBetweenSegmentsMs: 100, onPlayback: updatePlayback });
```

`generateDialogue` provides the same retained-audio path for dialogue. Text cannot
be empty/whitespace-only. Timing offsets reference each segment's original text;
audio times reference the whole recording, including explicit silence. Timing
precision follows available engine chunks, without invented word alignment.
New/resumed speech pauses previous playback on the same model; raw generation
queues resume when foreground inference permits. Other model instances remain
independent. Playback has callback terminal states rather than a completion promise.


## Complete-audio transcription

```ts
import { loadSpeechToText } from '@wfloat/wfloat-web';
const model = await loadSpeechToText('openai/whisper-tiny-en', { onProgress });
const transcription = model.transcribe(file, {
  onTranscript: ({ text }) => { preview.textContent = text; },
});
const result = await transcription.result();
console.log(result.text, result.stopReason, result.segments, result.words);
await model.unload();
```

`file` can be a File/Blob, browser AudioBuffer, or mono
`{ samples: Float32Array, sampleRate: number }` (including TTS result.audio).
The SDK decodes supported browser codecs, downmixes channels, and resamples.
Raw input is snapshotted when transcribe is called, including queued calls;
caller samples are never detached or modified. Encoding support depends on the browser.
Long recordings are processed in bounded windows; their recognition quality at
window boundaries still depends on the model. The entire decoded input may be in memory.

`transcribe()` returns its handle immediately. `onTranscript` replaces the whole
preview; it is not a text delta and may include provisional recognition.
Repeated `result()` calls observe the same outcome. `cancel()` resolves finalized
work with `stopReason: 'cancelled'` and, when available, `provisional: { text }`.
It does not promote an unfinished hypothesis into finalized text. Successful
completion uses `stopReason: 'complete'`. Actual failures reject with
`TranscriptionError`, preserving `cause` and `partialResult`. No `finished` promise
or inference progress percentage is exposed. File transcriptions on one instance
run FIFO; cancellation of a queued call prevents its inference from starting.

## Live transcription

```ts
import { loadStreamingSpeechToText } from '@wfloat/wfloat-web';
const model = await loadStreamingSpeechToText('k2-fsa/streaming-zipformer-en');
const session = await model.createSession({
  onTranscript: ({ id, text, isFinal }) => updateUtterance(id, text, isFinal),
  onError: error => showError(error.message, error.partialResult),
  // Optional application-selected backlog limit; none is imposed by default.
  maxBufferedAudioMs: 15_000,
});
startButton.onclick = () => session.startMicrophone().catch(showError);
stopButton.onclick = async () => showTranscript(await session.finish());
// Alternative input route instead of startMicrophone():
// await session.push({ samples, sampleRate });
```

Live events replace one utterance's text, with session-local string IDs `"0"`,
`"1"`, etc. Final events cannot be revised and do not end the session. Silence
emits no empty utterances; an empty provisional update can withdraw a previous guess.
Finalized result segments retain those IDs. Timing fields are optional and use
milliseconds relative to the original audio; missing timings are not invented.

`push()` acknowledges acceptance, **not completed recognition or backpressure**.
The caller can reuse samples after its promise resolves. For ordinary complete
recordings, use transcribe(file); a fast push loop can queue an entire file.
The SDK retains pending audio and model-required lookback, not the complete
microphone recording. Sustained lag warns about latency/memory and names
`maxBufferedAudioMs`; exceeding an explicit limit fails with a preserved partial
transcript instead of silently dropping audio. A limit does not make inference faster.

`finish()` stops SDK-owned capture, drains accepted audio, emits final updates,
and resolves the result. `result()` only waits; it does not stop capture.
`cancel()` stops without draining and resolves finalized text plus optional
provisional text. Neither control stops an application-owned audio source.
Do not mix external push with the session's microphone capture. Start microphone
capture from a user interaction; loading and creating a session never request permission.

`onError` promptly reports terminal session failures once; result/finish still
reject with that same error. Callback exceptions are separately reported application
errors and never stall inference. No automatic retry or STT pause/resume is provided.
Only one live session owns a model instance at a time; another session rejects.
Use independent loaded instances for simultaneous recognition. Unload cancels active
and queued work, stops owned capture, and waits for safe native cleanup.

### Current STT model capabilities

| Model IDs | Languages / tasks | Live recognition | Optional capabilities |
| --- | --- | --- | --- |
| `openai/whisper-tiny-en` | English transcription | Windowed | Segment timestamps |
| `openai/whisper-tiny`, `openai/whisper-base`, `openai/whisper-small` | Multilingual transcription; translation to English | Windowed | Segment timestamps |
| `UsefulSensors/moonshine-tiny`, `moonshine-ai/moonshine-base` | English transcription | Windowed | — |
| `k2-fsa/streaming-zipformer-en` | English transcription | Native incremental | English hotwords |
| `shaojieli/streaming-zipformer-fr` | French transcription | Native incremental | — |
| `k2-fsa/streaming-zipformer-zh-en` | Chinese/English transcription | Native incremental | — |
| `nvidia/parakeet-tdt-0.6b-v3` | Automatic recognition of 25 languages; transcription only | Windowed | — |

These adapters accept complete recordings and live sessions. Windowed live
recognition reruns offline recognition on bounded overlapping audio; it has
different latency and cost from native incremental recognition. Zipformer's
`language` validates compatibility rather than forcing the bilingual decoder.

Parakeet requires omitting `language`; translation, hotwords and word/segment
timestamp requests are unsupported. Its transport parts are reconstructed
internally before loading. Word timestamps are unavailable for the listed models;
segment timestamps are available only for Whisper. Predicted segment endpoints
are capped to the supplied audio duration (per processing window); text and start
times are preserved. Invalid or wholly out-of-range timings still fail. Other timing fields must not
be interpreted as word alignments. Unsupported options reject.

Recognition options belong on `transcribe()` / `createSession()`: `language`,
`task`, `timestamps`, and `hotwords`. English Zipformer hotwords accept English
letters, apostrophes and spaces; changing them rebuilds the recognizer between
operations, with initialization and temporary memory cost.

Legacy SttModel keeps its old signatures. Legacy root type names that collide with
the new surface are exported as `LegacyTranscribeOptions` and
`LegacyTranscriptionResult`; new callers should use the types above.

## Voice activity detection and shared microphone input

```ts
import { loadVoiceActivityDetection, createMicrophoneCapture } from '@wfloat/wfloat-web';

const vad = await loadVoiceActivityDetection('snakers4/silero-vad');
const detection = vad.detect(file, { returnAudio: true }); // Also Blob, AudioBuffer or { samples, sampleRate }.
const { segments } = await detection.result();
for (const segment of segments) {
  console.log(segment.id, segment.startMs, segment.endMs, segment.audio);
}

const session = await vad.createSession({
  returnAudio: true,
  onSpeechStart: event => console.log('speech began', event.id, event.startMs),
  onSpeechEnd: event => consumeClip(event.audio, event.startMs, event.endMs),
  onProbability: event => updateMeter(event.probability),
  onError: error => showError(error, error.partialResult),
});
// Call from a user gesture; session owns this microphone.
await session.startMicrophone();
const summary = await session.finish(); // Drains input; timing ranges only, no retained clips.
await vad.unload();
```

Options use model-appropriate defaults: `speechThreshold`, `silenceThreshold`,
`minSpeechDurationMs`, `minSilenceDurationMs`, `speechPaddingMs`, and `returnAudio`
(default false). Current Silero defaults are 0.5, 0.35, 250 ms, 500 ms, and 30 ms.
If only the speech threshold changes, the silence threshold defaults to
`max(0, speechThreshold - 0.15)`. Starts are confirmed after minimum speech,
then backdated to the padded start. Padding is best effort, clamped to available
input and the previous segment's end; clips never overlap. Probability events
contain `{ probability, startMs, endMs }`, including silence, at model frame cadence.
IDs are decimal strings starting at `"0"` for each operation.

File results retain requested audio. Live sessions deliver requested clips only
through `onSpeechEnd`; applications may retain them, and later inference never
invalidates delivered samples. `finish()` closes confirmed speech and resolves;
`cancel()` discards unfinished speech and pending input, resolving completed
ranges with `stopReason: 'cancelled'`. Failures reject with `VadError.partialResult`
and notify a live session's `onError` once. Application callbacks are not awaited;
their exceptions are reported separately. No automatic retry or maximum segment
splitting occurs. Live input has no default hard backlog limit; sustained backlog
warns. Applications must stop their source or cancel if processing falls behind.

For external PCM, call `await session.push({ samples, sampleRate })`; this
acknowledges acceptance, not completed inference. Rates are normalized internally.
File detections queue FIFO. A live session exclusively owns its model; competing
operations reject. Use another model instance for independent sessions.

To share one microphone between STT and VAD:

```ts
const microphone = createMicrophoneCapture(); // Inactive: no permission request yet.
const transcript = await speechToText.createSession({ onTranscript });
const activity = await vad.createSession({ onSpeechStart, onSpeechEnd });
await transcript.attachMicrophone(microphone);
await activity.attachMicrophone(microphone);

// Inside a click/tap handler:
await microphone.start();

// Later:
await microphone.stop();
const [text, ranges] = await Promise.all([transcript.finish(), activity.finish()]);
```

Attach all consumers before `start()` begins. Each session accepts one source;
external `push()` cannot be mixed with microphone input. Finishing/cancelling one
consumer detaches it without stopping others. Capture failure fails remaining
consumers. `stop()` is terminal and stops capture without finishing sessions;
create a new helper for another recording. The previous capture utility remains
available as `createLegacyMicrophoneCapture` during migration.

## Pocket TTS

`loadTextToSpeech('kyutai/pocket-tts')` uses the January 2026 English INT8
Pocket export. Other upstream Pocket versions/languages are not implied.

```ts
const model = await loadTextToSpeech('kyutai/pocket-tts');
const generation = model.generate('Hello from your device.', {
  referenceAudio: recording, // File/Blob, AudioBuffer, or { samples, sampleRate }
  temperature: 0.7,
  seed: 42,
  inferenceSteps: 5,
});
const result = await generation.result();
generation.dispose();
await model.unload();
```

These options also apply to `speak`, dialogue defaults, and individual dialogue
segments. Use `voiceId: 'alba'` instead of `referenceAudio` for the bundled preset;
Alba is also the default when neither is supplied. A segment's explicit voice or
reference replaces the dialogue's default voice selection. Supplying both on the
same resolved segment is an error. Reference audio is normalized to mono 24 kHz;
provide a nonempty recording of at most ten seconds. Caller PCM is snapshotted
before queued work; compressed audio decoding errors reject the generation.

`temperature` is a finite nonnegative sampling-noise control (default `0.7`).
Positive values below the smallest normal float32 (`2 ** -126`) are rejected
because the native parser cannot reliably accept them; zero is supported.
`inferenceSteps` is a positive integer flow-step count (default `5`): more steps
cost more computation and do not guarantee better speech. `seed` is an optional
integer from `0` through `2147483647`; omission uses fresh randomness. Seeds apply
to each prepared speech unit, and exact equality across devices/runtimes is not
promised. `emotion`, `intensity`, and `speed` have no effect on this Pocket
adapter and produce a warning if explicitly supplied. Conversely, Wfloat TTS
warns for the three Pocket sampling controls and rejects reference audio.

Synthesis yields bounded text units, with unit-level highlighting rather than
word alignment. Cancellation takes effect between units; Pocket's current latent
inference loop cannot be interrupted mid-unit. The existing generation retention,
playback arbitration, download, and cleanup contracts still apply.

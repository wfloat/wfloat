# New web text-to-speech implementation

`index.ts` exports `loadTextToSpeech`, `TextToSpeechModel`, and the generation,
playback, dialogue, audio and timing types. It does not alter the legacy TTS path.

## Integration

- Parent public index should re-export this directory's public `index.ts`.
- Bundle `worker.ts` as `dist/tts-next/tts-worker.js` (ES module). The loader creates
  one dedicated worker per loaded model. Parent's `build-next-workers.mjs` has the
  matching entry/output. The worker includes the existing generated sherpa factory
  and TS wrapper; it is not an unbundled `tsc` worker entry.
- `../runtime/urls.js` must register the runtime manifest and export the exact
  `SHERPA_WASM_URL`. Release builds must replace the development URL as they do for
  other runtime loaders.
- Loading acquires `acquireModelAssetLease` before `downloadModel`, filters the
  download-only ready event, reads all assets through `readAsset`, supplies cached
  `wasmBinary`, initializes the worker, and checks the deletion fence before ready.
  Cancellation/deletion tears down only this loader's private worker. The lease
  and caller signal detach before ready notification.
- No asset/network access occurs in the worker: model, tokens, stored eSpeak ZIP
  and WASM bytes arrive by transfer from the loader. Heap-view getters bridge the
  checked-in factory's memory-only exports without changing the legacy wrapper.

## Implementation boundaries

The concrete adapter preserves `wfloat/wfloat-tts` and `kyutai/pocket-tts`.
It also wires the seven approved Piper exports and Kokoro v1 INT8; see the
rollout contract below for pending runtime validation and blocked frontends. The narrow
`TextToSpeechBackend` seam is internal and allows deterministic tests or another
adapter without mixing model state. Preparation verifies original text alignment;
chunk timing is sentence/chunk timing, never fabricated word timing.

Raw generation retains audio until disposed. Every iterator replays from the
beginning; result assembly is shared and returned results retain object identity.
Samples are borrowed/read-only, including after delivery; copy before editing or
transferring them. Disposal releases references without detaching delivered data.

Direct speech retains at most approximately ten seconds ahead plus one in-flight
synthesis unit. Played chunks are released. A paused direct speech stops scheduling
further synthesis but keeps its buffered audio and position. Raw generation is
FIFO; active playback gets priority at prepare/synthesis boundaries, then older
background generations resume. There is no mid-sentence inference interruption.
Added pauses are generated as silence in bounded one-second pieces. Between-segment
pause defaults to zero, and explicit segment pause replaces it, including at end.
Sparse dialogue arrays and pauses whose individual or aggregate sample counts are
not safely representable are rejected before scheduling or interrupting playback.
These buffer limits/defaults are implementation choices, not new public options.

One lazily created AudioContext belongs to each model. Speech handles have separate
scheduled sources and positions. Sources are scheduled ahead on that context's
clock, not from `onended`. Pause cancels that speech's scheduled sources and resume
recreates them at the saved position. Model unload awaits both context closure and backend cleanup, including when either
cleanup fails. Adaptive
start buffering uses observed synthesis/audio ratio (200–3000ms); underruns remain
possible. Background suspension follows AudioContext time, with no background
execution guarantee. Thirty-two retained/unfinished jobs trigger one development
warning; no handles are evicted. Cancel disposable previews; dispose recordings.

Worker request failures remain scoped to their requests. Worker-level error or
messageerror rejects outstanding requests without marking the backend corrupted or
automatically terminating/reloading it. Later requests may still succeed. Explicit
model unload terminates the privately owned worker. Generation failures propagate to readers/results and unfinished
playback. Unobserved raw failures are logged; speech failures are callback-visible
and logged. Callback throws/rejections are application errors and do not corrupt
internal scheduling. Ordinary cancellation/disposal is not logged as a failure.

## Validation

From package root:

```sh
node --test tests/tts-next/*.test.mjs
node_modules/.bin/tsc --noEmit
node tests/tts-next/browser.mjs /path/to/playwright/index.mjs
# No model download: synthetic PCM through real Chromium Web Audio.
node tests/tts-next/browser.mjs /path/to/playwright/index.mjs --playback-only
```

Unit tests bundle only the new TS modules in memory with the existing esbuild.
The browser test uses actual cached/downloaded registry assets, a dedicated sherpa
worker and real AudioContext; its autoplay bypass flag is test-only. It checks
original whitespace/Unicode alignment, nonzero PCM, retained/dialogue playback,
source-clock adjacency under main-thread blocking, cached reload, cancellation,
and independent instances. It writes its report to a temporary directory. It does
not claim Safari coverage or a subjective audio-quality/listening assessment.

The download-free browser scenarios cover allocation stalls before audio scheduling,
failed native source starts, replay after failure, pause during silence, callback
triggered disposal, rapid handoffs/unload, and rendered-signal checks with an
AnalyserNode. These use controlled PCM and real audio nodes, not real inference.
Expected injected playback errors are logged; unhandled page errors fail the run.

`persistence: "off"` skips the durable-storage permission request, not IndexedDB
storage. The full-model cache assertions cover repeated loads within one page.
A separate four-byte local asset probe exercises the actual asset manager/store
across reload and a second same-origin tab, requiring one HTTP request and zero
persistence requests. The harness uses a nonpersistent Playwright context, so it
does not preserve a reusable browser profile after closing; neither check proves
cache survival across browser restarts or different origins.

The browser runner also launches a separate Chrome process without an autoplay
policy override. A document-script negative control must stay suspended before
interaction. A trusted Playwright button click calls `model.speak()` through the
default playback factory and creates/resumes its AudioContext inside the handler.
Synthetic synthesis waits 6.5 seconds so transient activation expires; the test
then requires a running context, rendered audio, one finished event, and a closed
context after unload. Audio is muted at browser output, not in the audio graph.

## Piper / Kokoro / Kitten rollout contract

No public options were added. `families.ts` lists the ten canonical IDs and
internal precision selections from `tmp/model-rollout/tts/proposed-manifest.json`
in the parent workspace. R2 **directory** components must be lowercase, including
`piper-en_us-*`, `piper-en_gb-*`, `piper-de_de-*`, `piper-fr_fr-*`, `kokoro-82m`
and `kittenml`; public IDs retain their canonical case and filenames may retain
source casing. No dated or export-v1 directory is used.

Parent-owned registry/asset-manager integration must supply these keys:

| Models | Required model asset keys | Shared dependencies |
| --- | --- | --- |
| Seven Piper voices, FP32 | `model_onnx` (converted Sherpa export), `model_tokens`, `model_config` (matching `.onnx.json`) | Speech WASM and `SHARED_ASSETS.espeak_ng_data_zip` |
| `hexgrad/Kokoro-82M`, INT8 v1 | `model_onnx`, `model_tokens`, `model_voices`, `lexicon_zh`, `rule_date_zh`, `rule_number_zh`, `rule_phone_zh` | Same speech WASM and stored eSpeak ZIP |
| Kitten Nano INT8 / Mini mixed INT8-FP16, 0.8 | `model_onnx`, `model_tokens`, `model_voices` plus shared eSpeak data | Raw text uses the shared version-8 frontend; rebuilt WASM Nano/Mini smoke passed, device qualification pending |

The Kokoro lexicon and FST keys correspond respectively to `lexicon-zh.txt`,
`date-zh.fst`, `number-zh.fst`, and `phone-zh.fst`. English lexicons can remain
retained provenance; this adapter explicitly selects eSpeak `en-us`/`en-gb`, so
it does not combine duplicate US/GB lexicons or silently choose the first one.
Register the shared ZIP in the download manifest for **all eight enabled IDs**,
including cached/offline loading and deletion-lease dependency tracking. Merely
adding a loader read does not make `downloadModel()` complete. Existing runtime
configuration must include the exact speech WASM URL. TTS/eSpeak/C API and the
required ORT kernels must be present in that binary. No new runtime library or
public language/quantization switch is introduced here.

Piper JSON is validated against the selected language, sample rate and speaker
count. LibriTTS aliases are read from its own config (`p3922`, not `3922`). VITS
uses the export's embedded frontend metadata, its own token map and matching
noise/length defaults. Generic text units preserve original UTF-16 offsets;
actual normalization and phonemization run in Piper/Kokoro, never Wfloat's
expressive English preparation. Voice IDs and finite positive float32 speed
are checked before queueing. Explicit Wfloat emotion/intensity and other ignored
sampling controls warn once; reference audio is rejected.

Kokoro retains all 54 exact voice IDs, including `em_santa=53`; **Japanese IDs
37–41 reject before generation**. The vendored multilingual frontend sends Han
characters through a Chinese lexicon even with a Japanese eSpeak voice, so a
real Japanese frontend is needed to enable those voices. Other voice prefixes
select their documented language. Chinese voices use the pinned Chinese lexicon
and normalization FSTs; Latin text within Chinese uses the export's English
fallback. Because Sherpa FSTs are engine-wide, switching between Chinese and
other voices frees and recreates the sole engine session. This avoids applying
Chinese number/date rules to other languages but adds load latency to mixed
language dialogue. It needs device validation. Kokoro style-row selection stays
in its real loader (content-token length); its waveform is not trimmed.

Kitten 0.8 now uses a shared vendor frontend port of pinned upstream
`ab5592c28b6f376ea4c3963e84ce6d6688241eca`. Web sends raw text as one source unit;
the engine runs `TextPreprocessor(remove_punctuation=False)` semantics and
upstream chunking, preserves punctuation/stress during phonemization, selects
style by each normalized chunk's Unicode character length, uses metadata terminal
tokens `10,0`, and trims 5,000 samples per inference chunk. Web sets silence scale
1 and does not apply Nano's priors or trim again. Voices are Jasper, Bella, Bruno,
Luna, Hugo, Rosie, Leo, Kiki, IDs 0–7, with export-name aliases also supported.

The missing-frontend gate is removed. A fresh jobs=2 WASM build passed Nano/Mini
smokes on 2026-10-05, including expected-input rejection and recovery. This still
requires shipping that rebuilt runtime; previously distributed WASM is not qualified. The shared path accepts up to
65,536 Unicode codepoints per call and further subdivides normalized text if
phonemes exceed the export's token limit. Audio/timing covers the original unit;
it is not word alignment or intra-graph streaming. See
[vendor contract and validation](../../../../vendor/sherpa-onnx/WFLOAT_KITTEN_08.md).
Older Kitten exports are not changed by this version-8 overlay.

Focused tests use ABI/worker/asset-store doubles, not inference. They cover the
actual WASM struct's string language JSON plus existing numeric Pocket extras,
family dispatch, config validation, model voices, dialogue controls, bounded
text, language/FST switching and failure cleanup. Existing Pocket tests remain.
Actual model loads, phoneme/listening comparisons, memory and performance on
browser targets remain untested. The shared eSpeak ZIP's full tree differs from
candidate bundles, so its frontend reuse still needs a smoke check.

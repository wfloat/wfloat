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

The concrete adapter supports `wfloat/wfloat-tts`, its existing named/numeric
voices, supported emotions, intensity 0–1, and finite positive speed. The narrow
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
node --test tests/tts-next/tts-next.test.mjs
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

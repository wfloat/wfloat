# Native language backend

`createLanguageNativeBackend` in `bridge.ts` implements the parent's
`LanguageBackend` except `prepareSchema`; the parent attaches its schema adapter.
`createNativeBackend` exposes the lower-level raw-JSON boundary for engine tests.
Each loaded instance owns a dedicated module worker, WASM heap, model and KV cache.
Bundle `worker.ts` beside this folder's compiled bridge as `llm-native-worker.js`.

Load options: `model: Blob | ArrayBuffer`, `contextSize`, optional `wasmBinary:
Uint8Array` (cached bytes), `wasmUrl`, `chatTemplate`, and load-only `signal`.
ArrayBuffer model bytes and the wasmBinary backing ArrayBuffer are transferred
(deduplicated), consuming those private buffers; Blob models are cloned by reference.
Loading cancellation terminates the worker. `numThreads` currently only accepts 1;
this artifact does not enable pthreads. The build selects an owned synchronous
llama-common logger instead of its background-thread logger, without changing
vendored files. Native warning/error severity is preserved in the console;
INFO/DEBUG metadata dumps are filtered. Decoder-only GGUF models are supported.
A missing GGUF template requires an explicit override; there is no silent ChatML
fallback in the new runtime. The original legacy exports remain available.

The native request is formatted using llama-common Jinja with tools, original
argument JSON, tool results, reasoning and optional answer schema. Token counting
uses exactly that formatting/tokenization path and does not decode or mutate KV.
Prefix reuse compares token IDs and removes the incompatible suffix. The last
prompt token is re-evaluated to obtain logits. Context is never shifted/truncated.
Usage includes the full formatted input (including cached tokens), and every
sampled output token, including EOG. Internal usage snapshots precede each step's content, preserving accounting when
public cancellation settles before the terminal event. Input includes the fully
formatted request even when prefill is interrupted. The internal done event also reports reused
input tokens. Public orchestration decides whole-operation accounting/stops.

A native step prefills at most 32 tokens or samples/decodes one token. The worker
then yields a browser task, permitting abort/count/schema messages. Cancellation
cannot interrupt an individual native decode call, model formatting, or schema
validation. Generation abort still yields terminal counts; the public adapter
maps native cancelled to complete because the parent records cancellation and
stop-string boundaries. Early iterator return waits for native teardown before
another round can start. Public orchestration filters stop strings in ordinary
text; native additional stops are template protocol delimiters.

Sampling overrides temperature, top-p/k, min-p, repetition/presence/frequency
penalties and seed individually on model metadata defaults (where present),
then llama-common defaults. Penalty history uses model metadata or llama-common's
64-token default. No separate model/mode recommendation registry has been introduced. Explicit reasoning preference uses the template's
`enable_thinking` support and warns when it cannot be honored; omission leaves
the common template adapter's default mode. Detection is template-based, not a
claim that a small model will produce reasoning or use tools reliably.

## Grammar and validation are separate

The shared owned validator's supported subset is documented in
`native/wfloat-core/src/schema/README.md`. Its unsupported/malformed schemas fail
preflight. The chat formatter/grammar converter can reject additional schemas it
cannot convert. Tools and structured answers cannot be combined in one request
(empty tools and prior tool history remain allowed).

Grammar constrains JSON syntax and the subset implemented by the vendored
llama-common converter. It is **not** a guarantee of exact runtime-schema
conformance: for example uniqueness, multiples, property counts, combinator
interactions and some numeric bounds require the shared runtime validator.
The parent must validate complete tool arguments/answers before exposing typed
values or executing tools, even when grammar sampling succeeded. Validation
failures follow the parent's correction policy. No transformed arguments replace
raw historical arguments. There is no new schema dependency or vendor patch.

Tool events require a complete, non-partial tool AST subtree from llama-common;
JSON parse success alone does not establish completion. Native tool arguments
are complete JSON text (model-specific non-JSON protocols are converted by
llama-common). The public adapter parses them and assigns nine-character alphanumeric call IDs
from a per-backend base36 counter, skipping IDs present in supplied history. This
keeps generated call/result histories compatible with Mistral templates.
Malformed protocol JSON rejects, never masquerading as a valid string argument.
The common message representation joins reasoning/text per channel for replay;
exact interleaving of those channels with tool calls is limited by the engine's
chat representation. The original public history remains parent-owned.

## Verification

`native/llama-wasm/browser-smoke.mjs BUILD_DIR MODEL_GGUF PLAYWRIGHT_MODULE` runs
real Chromium, model loading, token generation, repeated-prefix correctness,
structured output, abort accounting, count/schema during inference, oversized
input and load cancellation. It uses installed esbuild/Playwright and installs
nothing. Model bytes/build artifacts stay in temporary directories.
Configure `-DWFLOAT_LLAMA_PARSER_TEST=ON`, build `wfloat-llama-parser-test`, then run
its `.cjs` with Node for actual vendored-parser streaming/completeness tests.

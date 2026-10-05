# Kitten 0.8 shared frontend overlay

2026-10-05. Sherpa baseline remains
`9e6bc2f2b1db2cc9024e97886e8debf589e6d6a0`. This local overlay implements the
raw-text frontend for metadata version **8 only**. Web is wired to it. Actual
native C++ normalization, regex, Unicode, and eSpeak differential probes pass.
Rebuilt WASM validation is recorded below; audio equivalence to upstream ONNX
and production/device qualification are not implied.

## Pinned sources and licensing

KittenTTS `ab5592c28b6f376ea4c3963e84ce6d6688241eca`:

- `kittenml/kittentts_legacy/onnx_model.py`, staged
  `KittenTTS__legacy_onnx_model.py`, SHA-256
  `f1c1007237ef90dafe9ec3b7613102092671f60ca5c3df13bdb486dda70fbd5b`.
- `kittenml/preprocess.py`, staged `KittenTTS__preprocess.py`, SHA-256
  `a80265fbbdbbe8f946c046ec53aca79dd560675dcab92f1d2922bd25a854e333`.
  The relevant pipeline is **TextPreprocessor(remove_punctuation=False)**
  followed by **chunk_text**, not the separate `normalize_text` helper.
- Historical tag 0.8 `0c61f684b54fe962e4b7c2fa0285ed75f64ad402`, staged
  `KittenTTS__v0.8__onnx_model.py`, SHA-256
  `26ac99017273fe3b0f084feaa1e6a5f14408b9b7165b5a4cf5d9406b51a89758`,
  ends in `0`. The current legacy frontend ends in `10,0`, agreeing with the
  selected Nano/Mini export metadata. Metadata remains authoritative.

Retrieve these reference files from the pinned upstream commit; local staging
paths are not part of the public test contract.
The Kitten-derived pipeline and pattern data retain Apache-2.0 attribution and
[the upstream license](tests/kitten/KITTEN-LICENSE.txt).

Unicode behavior is pinned to the inspected Python reference's Unicode 16.0.0:
NFC, default lowercase (including contextual final sigma), decimal/word/space
classes, and case-insensitive matching. Reproducible tables store only nonidentity
mappings/ranges; Hangul decomposition/composition is algorithmic. The existing
Piper `uni_algo.h` is Unicode 15.0.0; substituting it silently would change the
pinned behavior for newly assigned characters. No Unicode runtime dependency
was added. [Unicode license](tests/kitten/UNICODE-LICENSE.txt) is retained.
The generator checks the Kitten source hash and the Unicode input hash:
[DerivedCoreProperties 16.0.0](https://www.unicode.org/Public/16.0.0/ucd/DerivedCoreProperties.txt),
SHA-256 `39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd`.

The eSpeak call protocol was checked against
[phonemizer 3.3.0's wrapper](https://github.com/bootphon/phonemizer/blob/v3.3.0/phonemizer/backend/espeak/wrapper.py)
and [punctuation behavior](https://github.com/bootphon/phonemizer/blob/v3.3.0/phonemizer/punctuation.py).
The new Kitten-specific bridge preserves punctuation around eSpeak calls, uses
UTF-8 and IPA with underscore phone separators, removes the separators, and
retains stress/language flags. It does not apply Piper's NFD conversion or
reconstruct punctuation from clause terminators. It shares the process-global
eSpeak mutex with Piper. No phonemizer Python runtime or source files are
bundled. Existing eSpeak licensing is unchanged.

## Implemented pipeline

1. Normalize to NFC; remove HTML, URLs, and email addresses; expand contractions.
2. Expand IP addresses, leading decimals, currency, percentages, scientific
   notation, time, ordinals, units, scale suffixes, fractions, decades, phone
   numbers, ranges, model names, and generic numbers **in upstream order**.
3. Lowercase and collapse whitespace. Keep punctuation. Roman numeral expansion,
   stopword/accent removal, and hashtag/mention removal remain off, as upstream.
4. Run upstream sentence-boundary/abbreviation logic, split long sentences on
   words at 400 codepoints, and append a comma if terminal prosodic punctuation
   is absent. Style length is measured **after** this step, including punctuation.
5. Phonemize, apply Unicode `\w+|[^\w\s]` spacing before unknown-symbol filtering,
   add metadata start/end/pad IDs, and infer one chunk at a time. Use
   `min(chunk_codepoint_count, style_rows - 1)`, never byte/token/UTF-16 length.
6. Trim exactly 5000 samples from **each** inference result, clamped at zero,
   before callbacks, concatenation, or explicitly requested silence scaling.

Except for the documented scientific-float correction below, numeric quirks are retained: generic integers round through `float`, percentages
and units round decimal values through `float`, other decimal paths preserve
trailing zeroes, and the number-word vocabulary stops at trillion. Other
source conversion exceptions in active expansion paths fail preparation;
only generic number replacement catches conversion errors and preserves its
original match. Integer parsing uses the reference Python's 4300-digit limit.

Fixed preprocessing regexes are generated from the pinned Python patterns.
A private Unicode-codepoint matcher executes only the supported fixed opcodes;
there is no public regex API or locale-sensitive `std::regex` behavior. Pattern
compilation rejects unsupported constructs. Matching uses an explicit stack
and bounded work, rather than C++ recursion per consumed character.

## RN / Python / Web contract

- Pass **raw text** to ordinary Sherpa Generate; no SDK cleaner, prephonemization,
  or optional FST cleanup for these 0.8 records. The version-8 path owns cleanup
  and chunking. A caller-chosen raw unit is allowed, but splitting a currency,
  URL, contraction, or sentence changes normalization/chunking context.
- Set **silence scale 1**, ordinary speed (default 1), and validated speaker ID
  0–7. Engine speed priors are already applied: Nano 0.8 except Hugo 0.9; Mini 1.
  Do not multiply priors or trim again in SDK code.
- Treat null/empty generated audio as preparation or synthesis failure. The
  existing C API returns a null handle on preparation failure and Web surfaces
  an Error. Valid tiny percentages are supported by the correction below.
- Voices in artifact order: Jasper, Bella, Bruno, Luna, Hugo, Rosie, Leo, Kiki.
  Web also accepts the corresponding `expr-voice-{2,3,4,5}-{m,f}` aliases.
- Web forwards one raw source unit and preserves its original UTF-16 range.
  Internally completed chunks are combined into that unit's result; timestamps
  describe the returned unit, not words or normalized-text offsets. There is no
  intra-graph streaming claim. Cancellation can end native callbacks between
  internal chunks or terminate the Web worker.
- Version detection is metadata `version == 8` inside the Kitten engine; Web
  enables the two exact standard-model IDs. Legacy/default version 1 and unknown
  future versions keep their previous frontend/style/tail behavior.
- C API structures and public SDK types are unchanged. Web's existing low-level
  generation wrapper gains optional `silenceScale` so Kitten can request 1;
  other adapters retain their current default. All consumers need rebuilt
  runtimes before relying on this source change. RN/Python adapters must follow
  the same raw-text contract.

## Explicit bounds and differences for oversized input

Input is limited to 65,536 Unicode codepoints per Generate call; Web checks the
same limit before synthesis. Fixed-pattern work is capped at ten million
instructions per pass. These fail preparation rather than silently misread text.

Upstream bounds **text** at 400 characters; the selected Sherpa exports also
advertise a 400-**token** limit. When a cleaned chunk exceeds that token limit,
the engine subdivides its **text** near the midpoint (prefer whitespace), adds
terminal punctuation, rephonemizes, and recomputes each style row. This bounded
runtime policy changes chunk boundaries relative to upstream for oversized
phoneme inputs; token IDs are never split blindly. All chunks are prepared
before inference so a preparation error does not return partially generated
speech. Non-progressing subdivision fails explicitly.

No decision or new dependency license acceptance is required. Native frontend
and eSpeak differential validation pass. Consumer rebuilds and broader output
quality, memory, kernels, and lifecycle qualification are separate consumer checks.
The former Web missing-frontend gate has been removed. This does not imply a
published/rebuilt runtime is already qualified. Japanese Kokoro is unchanged.

## Validation and reproduction

Run from the SDK root (`wfloat/`). Set `KITTEN_REFERENCE_PREPROCESS` to the
hash-pinned upstream `kittenml/preprocess.py` above. The differential suite and
data generator require CPython with Unicode 16.0.0:

```sh
clang++ -std=c++17 -Wall -Wextra -Werror -I vendor/sherpa-onnx \
  vendor/sherpa-onnx/tests/kitten/text_probe.cc -o /tmp/wfloat-kitten-text-probe
python3 vendor/sherpa-onnx/tests/kitten/check_source.py \
  "$KITTEN_REFERENCE_PREPROCESS" \
  --probe /tmp/wfloat-kitten-text-probe
node --test packages/wfloat-web/tests/tts-next/families.test.mjs
```

Actual executed validation (2026-10-05):

- Native probe compiled with `clang++ -std=c++17 -Wall -Wextra -Werror`.
- 1,388 normalization/chunking cases compared actual C++ output to pinned Python;
  includes 67 intentionally corrected scientific-float outcomes (source errors
  retained in fixtures), one retained source exception, random numeric inputs,
  floating-point underflow, large integers, accents, punctuation, and chunk edges.
- The same 1,388 cases also pass in an Emscripten 4.0.8 standalone WASM
  C++ probe (normalization and chunking, with exception handling enabled).
- 49,910 actual C++ fixed-regex comparisons against Python `re`, including all
  capture offsets, greediness, lookaround, Unicode boundaries and case folding.
- Actual C++ NFC and lowercase each tested on 1,114,064 inputs: every Unicode
  scalar plus 2,000 combining-mark/context sequences. Generated mappings are
  independently checked against Unicode 16.
- A decimal containing 1,000 zeros explicitly reaches the documented pattern-work
  bound. It fails preparation; it is not counted as an upstream parity success.
- 454 actual C++ punctuation/eSpeak comparisons against phonemizer 3.3.0 pass,
  using the existing native eSpeak static library (linked into a temporary dylib)
  and staged Kitten eSpeak data. No production dependency was added. The test
  helper executes the shared punctuation helper and the same eSpeak call mode.
- Standalone spacing/helper tests pass (515 cases plus exhaustive word classes).
- 13 Web family tests and 39 Web TTS tests pass; Web `tsc --noEmit` passes.
  Parent's Kokoro language IDs and fp32 selection remain intact.

Reproduce the actual native comparison by compiling
`tests/kitten/text_probe.cc` with `-I vendor/sherpa-onnx`, then running
`check_source.py SOURCE --probe /absolute/path/to/probe`. A missing probe causes
explicit skips, not a parity claim. `check_phonemes.py PROBE LIBRARY DATA_PARENT`
requires the separately built `phoneme_probe.cc` and phonemizer 3.3.0 in an
isolated test environment. Generated fixtures include source hash/version.

The initial real WASM test exposed stripped exception handlers: commas can match
upstream's generic numeric regex, whose caught conversion failure should preserve
the text. The scoped Emscripten overlay enables `-fexceptions` in
`offline-tts-impl.cc` (the Kitten header's actual translation unit) and
`piper-phonemize-lexicon.cc`, plus the linked exception runtime. This resolved the
uncaught numeric WASM exception without changing unrelated compilation units.

Rebuilt Nano and Mini WASM runtimes each passed four finite, nonempty 24 kHz
cases, including tiny percentages, currency/time, accents and multiple sentences.
This validates the exercised adapter/runtime path, not upstream waveform
identity or every device. Runtime binaries and local qualification reports are
not public test fixtures.

The reusable WASM harness reads a caller-provided asset manifest and eSpeak ZIP.
From the SDK root, after installing Web development dependencies and building
the speech runtime, run each model in a separate process with a 120-second
supervisor timeout:

```sh
node vendor/sherpa-onnx/tests/kitten/qualify-wasm.mjs \
  KittenML/kitten-tts-nano-0.8 \
  --manifest "$KITTEN_MANIFEST" --espeak "$KITTEN_ESPEAK" \
  --output "$KITTEN_OUTPUT"
```

Repeat with `KittenML/kitten-tts-mini-0.8`. `--runtime DIR` overrides the default
`build-wasm-simd-speech/install/bin/wasm/speech` directory under this vendor.
All four path options also accept `KITTEN_MANIFEST`, `KITTEN_ESPEAK`,
`KITTEN_OUTPUT`, and `KITTEN_RUNTIME` environment variables. `--help` describes
the options without importing the runtime. The manifest has this structure:

```json
{"models":[{"modelId":"KittenML/kitten-tts-nano-0.8","assets":[
  {"role":"model","localPath":"model.onnx","sha256":"<64 hex characters>"},
  {"role":"tokens","localPath":"tokens.txt","sha256":"<64 hex characters>"},
  {"role":"voices","localPath":"voices.bin","sha256":"<64 hex characters>"}
]}]}
```

Paths resolve relative to the manifest; absolute paths are also accepted. Each
asset's bytes must match its recorded hash. The harness does not download assets
or copy runtime fixtures. It writes reports and WAVs only to the explicit output
directory, frees the session, and checks successful synthesis of
`The rate is 0.00001%.`. Use an output directory outside the source tree.
`KITTEN_PROBE_TEXT` is a diagnostic single-case override, not the four-case suite.

## Intentional correction of upstream scientific-float failures

Valid `0.00001%` fails upstream because decimal normalization produces float
representation `1e-05`, then the integer helper attempts `int("1e-05")`.
The shared C++ float-to-words helper now expands negative exponents before
speaking decimal digits: `zero point zero zero zero zero one percent`.
The same correction handles tiny units and negative values. Positive exponents
use mantissa plus `times ten to the` plus exponent, avoiding truncation through
the inherited trillion-limited integer vocabulary. Ordinary non-scientific
values retain their previous behavior. No SDK surface changes are required.

The 1,388-case corpus records the unmodified source result first and separate
`wfloat` corrected expectations for 67 formerly failing cases. Actual native and
standalone WASM C++ probes pass them. The remaining source exception is a
fullwidth-digit IP address (`１２３.１２３.１.１`), whose source implementation
indexes an ASCII-only digit map; it remains an upstream limitation, not a claim
that such text is invalid. A separate pathological-input work bound is documented
above and is not counted as source parity.

## Direct edit inventory

Under `vendor/sherpa-onnx/`:

- `WFLOAT_VENDOR.md`, `WFLOAT_KITTEN_08.md`: overlay provenance/contract.
- `build-ios.sh`, `build-android-arm64-v8a.sh`: honor bounded build job count.
- `sherpa-onnx/csrc/CMakeLists.txt`: the scoped WASM exception setting above.
- `sherpa-onnx/csrc/offline-tts-kitten-{model.h,model.cc,impl.h}`:
  version detection, raw-text preparation, style length and per-chunk trim.
- `sherpa-onnx/csrc/piper-phonemize-lexicon.cc`: version-8 eSpeak path/shared mutex.
- `sherpa-onnx/csrc/offline-tts-kitten-{utils,unicode,text-data,text-unicode,
  regex-data,regex,numbers,text,phonemize}.h`: internal helpers/generated data.
- `tests/test_kitten_08_frontend.py`, `tests/kitten/`: differential probes,
  source/data generator, fixtures, licenses, and bounded WASM harness.

Under `packages/wfloat-web/`:

- `src/tts-next/{families,load,backend,sherpa}.ts`: Kitten configuration/assets,
  raw-text forwarding, voice mapping and silence scale.
- `src/wasm/sherpa-onnx-tts.ts`: optional generation silence scale, preserving the
  old default for other callers.
- `tests/tts-next/families.test.mjs`, `src/tts-next/README.md`: focused tests/docs.

The generator `tests/kitten/generate_frontend_data.py SOURCE DCP_FILE` reproduces
Kitten regex and Unicode data with CPython Unicode 16.0.0 and hash-checked inputs.
No registry records, generated asset URLs, model files, uploads, or pushes are
part of this overlay.

## Native build reproduction

[source-freeze.json](tests/kitten/source-freeze.json) preserves a historical
qualification snapshot with SDK-relative source paths. It is not a promise that
shared files never change afterward. Local build logs, device qualification
reports, staging paths and runtime hashes are excluded by `tests/.gitignore`.

The iOS 13 formatter uses classic-locale shortest-roundtrip precision search
because floating `std::to_chars` requires iOS 16.3 in the inspected SDK.
Correctly rounded subnormals are accepted even when libc++ reports underflow.
Actual native and standalone WASM probes each passed 99,968 finite-double repr
comparisons. No new dependency or device deployment-target increase is needed.

Use `WFLOAT_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 bash build-ios.sh` from
this vendor directory to build device arm64 and simulator arm64/x86_64. The
Android arm64 helper also honors `WFLOAT_BUILD_JOBS`; set Android NDK and normal
Sherpa build options for the consumer. Only arm64-v8a was exercised in the
bounded Android engine rebuild; do not infer other ABI validation. Consumer
relink and model/lifecycle qualification must follow engine replacement.

## iOS ONNX Runtime compatibility

iOS qualification found ORT 1.17.1 rejects both models' unused
`ai.onnx.ml` opset-5 import before inference. The earlier engine build/staging
success did not establish iOS model compatibility. Android 1.27.1 is unaffected.

`build-ios.sh` now pins the existing publisher's
`onnxruntime.xcframework-1.18.1.tar.bz2` (66,078,522 bytes), SHA-256
`52a82ca181186234a667a52e53f643bbb5845abe2ee47d3b1f0b0e69cf21da3d`.
The downloaded GitHub release bytes match the publisher mirror's LFS SHA-256.
Its recipe commit is `b88e7c2b8d4098e6344c1bab247b2c228a8d8a49`.
ORT 1.18.1 pins ONNX 1.16.0, whose released-domain map accepts ML opset 5.
There are no model edits, public API changes, or disabled validation checks.

Actual archive inspection confirms ORT API 18 headers and the existing flat
static-library layout: arm64 device minimum iOS 12.0; x86_64 simulator 12.0;
arm64 simulator 14.0. The latter is the Apple-silicon simulator floor, not a
device deployment-target increase. The Sherpa device target remains iOS 13.0.
The build script checks cached/downloaded archive hashes and updates the active
version symlink even on a hot cache. Isolated cold-cache, hot-cache and corrupt
archive tests pass, as does shell syntax validation.

All three iOS engine slices built and packaged successfully against ORT 1.18.1.
When reusing build caches, invalidate ORT-header dependents: extracted archive
timestamps can predate existing object files. Verify the framework architectures,
API headers and final consumer linkage after staging.

The upgraded iOS public SDK passed Kitten qualification. Repeated LibriTTS
execution exposed a separate VITS memory-pattern issue on exact ORT 1.18.1;
the version-gated fix and repeated-session reproduction are documented in
[the vendor notes](WFLOAT_VENDOR.md#vits-session-compatibility-with-ort-1181).
Build/staging success alone does not establish model compatibility.

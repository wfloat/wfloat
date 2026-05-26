# wfloat

Wfloat monorepo for shared native infrastructure, backend integrations, and
platform SDKs.

## Docs

Private planning docs may live outside this public repo in local development
checkouts. When present, they are expected at `../docs/`.

- `../docs/WORKING_DECISIONS.md` - Living record of the major decisions already made
- `../docs/ARCHITECTURE.md` - Current architecture and responsibility boundaries
- `../docs/API_ABSTRACTION.md` - Target public API shape across platforms
- `../docs/MODEL_ASSET_API.md` - V1/v2 asset manifest direction and compatibility rules
- `../docs/MODEL_DISTRIBUTION.md` - Upload checklist and hosting plan by model family
- `../docs/MODEL_SURFACE_DECISIONS.md` - Family-vs-task API surface decisions
- `../docs/TTS_CORE_BOUNDARY.md` - What generic TTS logic belongs in `wfloat-core`
- `../docs/MONOREPO_LAYOUT.md` - Current repo structure and directory roles
- `../docs/SUPPORTED_MODELS.md` - Canonical deduped Wfloat support catalog and priorities
- `../docs/IMPLEMENTATION_TRACKER.md` - Ongoing planning and execution format
- `../docs/COMPETITOR_RESEARCH.md` - Governing workflow for competitor research

## Top-Level Layout

```text
wfloat/
  CMakeLists.txt
  examples/
  native/wfloat-core/
  packages/
  vendor/
```

## Current Native Status

- `native/wfloat-core/` has the first shared TTS ABI draft
- `vendor/sherpa-onnx/` is wired into the top-level CMake build
- Linux `wfloat-core-shared` builds successfully and can be loaded by the
  Python wrapper through `WFLOAT_CORE_LIBRARY`

## Reference Policy

Competitor research in this repo is governed by:

- `../docs/COMPETITOR_RESEARCH.md` when private planning docs are present

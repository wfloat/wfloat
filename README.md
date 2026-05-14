# wfloat

Wfloat monorepo for shared native infrastructure, backend integrations, and
platform SDKs.

## Docs

- `docs/WORKING_DECISIONS.md` - Living record of the major decisions already made
- `docs/ARCHITECTURE.md` - Current architecture and responsibility boundaries
- `docs/API_ABSTRACTION.md` - Target public API shape across platforms
- `docs/MODEL_SURFACE_DECISIONS.md` - Family-vs-task API surface decisions
- `docs/TTS_CORE_BOUNDARY.md` - What generic TTS logic belongs in `wfloat-core`
- `docs/MONOREPO_LAYOUT.md` - Current repo structure and directory roles
- `docs/SUPPORTED_MODELS.md` - Canonical deduped Wfloat support catalog and priorities
- `docs/IMPLEMENTATION_TRACKER.md` - Ongoing planning and execution format
- `docs/COMPETITOR_RESEARCH.md` - Governing workflow for competitor research

## Contracts

- `contracts/typescript/public-api.ts` - Draft TypeScript public API contract
- `contracts/python/public_api.py` - Draft Python public API contract

## Top-Level Layout

```text
wfloat/
  CMakeLists.txt
  docs/
  examples/
  native/wfloat-core/
  packages/
  vendor/
```

## Reference Policy

Competitor research in this repo is governed by:

- `docs/COMPETITOR_RESEARCH.md`

# Contracts

This directory holds draft public API contracts for Wfloat.

These files are not production implementations. They are concrete scaffolding
for the API shape we are working toward across platform packages.

Keep them aligned with:

- `../docs/API_ABSTRACTION.md`
- `../docs/MODEL_SURFACE_DECISIONS.md`
- `../docs/TTS_CORE_BOUNDARY.md`
- `../docs/WORKING_DECISIONS.md`

Current contract drafts:

- `typescript/public-api.ts`
- `python/public_api.py`

Current focus:

- generic `TtsModel` contract with shared structured synthesis results
- separate `synthesizeDialogue(...)` operation
- no playback assumptions in the shared TTS result types

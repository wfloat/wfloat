# Wfloat ONNX Runtime artifact builder

This tool builds the ONNX Runtime C and C++ packages used by Wfloat and
Sherpa. It uses Microsoft build entry points and exact Microsoft source
revisions from `source-lock.json`.

Run commands from the public Wfloat repository root.

## Commands

List the available targets:

```sh
./tools/onnxruntime-build/onnxruntime-build list targets
```

Add `--json` to inspect the complete resolved target definitions. The output
comes from the catalog used by local builds and CI.

Inspect a build without downloading source or running the platform toolchain:

```sh
./tools/onnxruntime-build/onnxruntime-build build \
  wasm-static_lib-simd \
  --plan \
  --jobs 4
```

Build and validate a target:

```sh
./tools/onnxruntime-build/onnxruntime-build build \
  wasm-static_lib-simd \
  --version 1.29.0 \
  --jobs 4
```

Validate an existing archive:

```sh
./tools/onnxruntime-build/onnxruntime-build validate \
  wasm-static_lib-simd \
  path/to/archive.zip
```

Use `--help` on the main command or a subcommand for all options. Target
preflight checks report missing or incorrect platform tools before a build.
The family workflows under `.github/workflows/` show the supported CI setup.

`--skip-tests` and `--skip-smoke` record omitted checks. They do not report
those checks as passed.

## Local builds

A real build requires committed builder, workflow, and shared-action files.
The first 12 characters of that Wfloat commit identify the archive. Plan and
validation commands do not create an artifact and do not require this check.

The default working directories are:

```text
tools/onnxruntime-build/.cache/
tools/onnxruntime-build/.build/
tools/onnxruntime-build/.out/
```

Git ignores these directories. The build command accepts other locations.

The builder can use an existing Microsoft checkout with `--source-dir`. The
checkout, its origin, its commit, and all recursive submodules must match the
committed source lock. The checkout must not contain local files or changes.

## Artifacts and publication

Each archive has one top-level directory and includes Microsoft's `LICENSE`
and `ThirdPartyNotices.txt`. Its name contains the target family, ONNX Runtime
version, and Wfloat builder commit:

```text
onnxruntime-<family>-<version>-<12-character-builder-commit>.zip
```

The catalog marks a target `verified` only after Wfloat has accepted completed
artifact evidence. A generated command plan or a CI matrix entry is not
verification.

Local builds never publish. Pull-request and manual workflow runs retain their
successful artifacts in GitHub Actions but do not publish them. On a push to
`main`, each family workflow publishes the artifacts that its current run
successfully built and validated. Published objects are immutable.

Publication does not select an artifact for a consumer. Consumer URL and
SHA-256 pins remain separate reviewed changes.

## Sources of truth

- `source-lock.json` owns Microsoft repository and revision pins.
- `onnxruntime_build/recipes/` owns targets and Microsoft command plans.
- `onnxruntime_build/validate.py` and its helpers own archive validation.
- `tests/` owns command, catalog, package, and validation contracts.
- `.github/workflows/onnxruntime-builder-*.yml` owns automatic targets and
  runner setup.
- `.github/workflows/onnxruntime-publish.yml` and
  `scripts/publish-onnxruntime-artifacts.py` own registry publication.

Do not copy these facts into a static target or workflow catalog. Inspect the
current source or run `list targets --json`.

## License

The builder uses the repository's [MIT license](../../LICENSE). Generated
archives retain the license and notices from the Microsoft source revision
that produced them.

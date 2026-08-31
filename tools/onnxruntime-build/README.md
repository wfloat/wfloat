# Wfloat ONNX Runtime artifact builder

This directory builds the ONNX Runtime C and C++ packages used by Wfloat and
Sherpa. It is an independent Wfloat implementation that drives Microsoft ONNX
Runtime's own source and build entry points. The default source version is
`1.29.0`; every cataloged version maps to one exact Microsoft commit, and every
build records an exact committed Wfloat builder revision.

Target definitions live beside their platform command plans in
`onnxruntime_build/recipes/`. The small `source-lock.json` file contains only
the Microsoft repository, default version, and exact version-to-commit map.
`list targets --json` assembles those inputs into the fully resolved catalog
used by CI.

Start with the task you need:

- [Build or validate an artifact](docs/how-to/build-and-validate.md)
- [Inspect the target catalog and package contract](docs/reference/target-catalog.md)
- [Understand the build and publication boundaries](docs/explanation/design-and-publication.md)
- [Review implementation provenance](PROVENANCE.md)

The three public commands are:

```sh
./tools/onnxruntime-build/onnxruntime-build list targets
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd --version 1.29.0 --jobs 4
./tools/onnxruntime-build/onnxruntime-build validate wasm-static_lib-simd path/to/archive.zip
```

The list marks targets `verified` only when Wfloat has completed artifact
evidence, not merely a generated command plan. Other implemented recipes are
shown as `unverified`, and a build prints that distinction. ROCm and
OpenHarmony are absent at Microsoft v1.29.0 because this exact source revision
does not provide the required build machinery.

Build commands create local cache, intermediate, and output directories below
this directory. Those directories are ignored by Git. Nothing in this builder
publishes to Wfloat's registry, creates registry metadata, or changes consumer
URLs and hashes.

GitHub Actions separates contract checks from Android, Apple, Linux, Windows,
and WebAssembly builds. Each family owns fixed hosted runners and only its
intended migration/evidence targets; the same bounded family can be dispatched
manually without a target, runner, version, or source-revision input. Some live
consumers still pin older artifacts while the v1.29.0 targets gather evidence.
An automatic build does not become `verified` until its completed evidence is
reviewed. Actions revalidates each archive and retains the completed zip for
three days so it can be inspected without granting the workflow publication
authority.

The source is licensed under the repository's [MIT license](../../LICENSE).
Generated archives contain Microsoft's `LICENSE` and
`ThirdPartyNotices.txt` from the exact source revision that was built.

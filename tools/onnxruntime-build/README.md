# Wfloat ONNX Runtime artifact builder

This directory builds the ONNX Runtime C and C++ packages used by Wfloat and
Sherpa. It is an independent Wfloat implementation that drives Microsoft ONNX
Runtime's own source and build entry points. The default source version is
`1.29.0`; every cataloged version maps to one exact Microsoft commit, and every
build records an exact committed Wfloat builder revision.

Start with the task you need:

- [Build or validate an artifact](docs/how-to/build-and-validate.md)
- [Inspect the target catalog and package contract](docs/reference/target-catalog.md)
- [Understand the build and publication boundaries](docs/explanation/design-and-publication.md)
- [Review implementation provenance](PROVENANCE.md)

The three public commands are:

```sh
./tools/onnxruntime-build/ort-builder list targets
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd --version 1.29.0 --jobs 4
./tools/onnxruntime-build/ort-builder validate wasm-static_lib-simd path/to/archive.zip
```

Build commands create local cache, intermediate, and output directories below
this directory. Those directories are ignored by Git. Nothing in this builder
publishes to Wfloat's registry, creates registry metadata, or changes consumer
URLs and hashes.

The source is licensed under the repository's [MIT license](../../LICENSE).
Generated archives contain Microsoft's `LICENSE` and
`ThirdPartyNotices.txt` from the exact source revision that was built.

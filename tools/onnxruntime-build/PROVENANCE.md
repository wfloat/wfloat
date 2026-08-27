# Provenance

Wfloat independently implemented this artifact builder from Microsoft ONNX
Runtime source, Microsoft documentation and build machinery, platform and
toolchain documentation, and observable Wfloat/Sherpa consumer and package
contracts.

## Implementation inputs

The implementer used only:

- Microsoft ONNX Runtime source, build scripts, documentation, tests, and
  release-package contracts;
- platform SDK, compiler, CMake, execution-provider, and archive-format
  documentation;
- Wfloat's current public source and consumer build contracts; and
- Wfloat's independent-implementation specification describing target names,
  required files, architectures, linkage, and consumer behavior.

The implementer did not inspect or use source, history, workflows, scripts,
patches, diffs, disassembly, or implementation details from
`csukuangfj/onnxruntime-build`, `csukuangfj/onnxruntime-libs`,
`wfloat/onnxruntime-build`, its removed private submodule, or Supertone's
derivative builder.

## Build identity

By default the builder fetches the exact `v<version>` tag from
`microsoft/onnxruntime`, including Microsoft's required submodules. A caller may
instead supply a full 40-character Microsoft commit. The build prints the
resolved Microsoft commit.

The archive name contains the first 12 hexadecimal characters of the committed
Wfloat revision containing the builder. A real build refuses dirty builder or
builder-workflow paths so that this revision identifies the source that created
the package.

## Distributed notices

Every generated archive copies Microsoft's `LICENSE` and
`ThirdPartyNotices.txt` from the exact source checkout. Wfloat's builder source
is distributed under the public repository's MIT license.

## Reproduction and validation

From the identified Wfloat commit, list the resolved target and rebuild it with
the recorded version, platform toolchain, and bounded job count:

```sh
./tools/onnxruntime-build/ort-builder list targets --json
./tools/onnxruntime-build/ort-builder build <target> --version <version> --jobs <jobs>
```

Validate an existing archive with the same public command used by CI:

```sh
./tools/onnxruntime-build/ort-builder validate <target> <archive.zip>
```

Reproduction means rebuilding and satisfying the same source, package,
metadata, linkage, and consumer contracts. Byte-for-byte identity with an
artifact from another build environment or distributor is not claimed or
required.

# Build and publication boundaries

The builder separates three concerns: Microsoft owns ONNX Runtime's build
machinery, Wfloat owns target and package contracts, and Wfloat's registry owns
immutable published objects. Keeping those concerns separate makes the public
builder reproducible without turning a build command into a release authority.

Platform adapters supply declarative target inputs to Microsoft's build
scripts. Microsoft's Apple assembler creates XCFramework slices, its
WebAssembly target creates the bundled static archive, and its ordinary driver
handles native and cross-platform CMake generation. Wfloat's packaging layer
then normalizes only the observable consumer contract: stable headers and
libraries, one archive root, immutable identity, and retained notices.

Microsoft's Release WebAssembly configuration normally adds `-flto` even when
its general LTO option is off. Wfloat's WebAssembly adapter supplies a later
Release `-fno-lto` compiler flag because Sherpa must perform the final
Emscripten link. Package validation extracts an archive member and rejects LLVM
bitcode in place of a WebAssembly object.

The target catalog is deliberately broader than Wfloat's publication set. A
target states build capability and validation expectations; it does not imply
that a consumer needs the package or that Wfloat has approved publication.
Provider/toolchain incompatibility is therefore an explicit error. For example,
a Microsoft tag without the ROCm provider cannot be relabeled as MIGraphX, and
a CUDA target cannot silently use another CUDA major.

Local and CI builds call the same `ort-builder build` and `ort-builder validate`
commands. CI uploads only temporary workflow artifacts, uses read-only
repository permissions, and has no registry write credentials. Registry
publication is a separate Wfloat operation after the exact archive passes its
real downstream consumer contract and receives explicit approval.

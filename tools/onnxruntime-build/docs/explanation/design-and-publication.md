# Build and publication boundaries

The builder separates three concerns: Microsoft owns ONNX Runtime's build
machinery, Wfloat owns target and package contracts, and Wfloat's registry owns
immutable published objects. A local or CI build has no release authority.

## Shared core and recipe ownership

The shared core owns behavior that must be identical for every target:

- the exact Microsoft source lock, acquisition, and recursive cleanliness
  checks;
- the committed Wfloat builder identity and command execution;
- deterministic zip creation, Microsoft license/notices, and common package
  staging;
- safe extraction, archive identity, and reusable binary/linkage validation;
- CLI parsing and resolved JSON output.

Practical platform boundaries own their target data and Microsoft command
plans in `onnxruntime_builder/recipes/`: Android, Apple XCFramework, macOS
shared, macOS static, Linux native, Linux cross/RISC-V, CUDA, Windows CPU,
Windows ARM64X, DirectML, and WebAssembly. A recipe contains related
architecture, linkage, and feature variants as data; there is no module per
artifact identifier.

`source-lock.json` is separate because source provenance changes on a different
review axis than platform contracts. Its format is deliberately limited to:

```json
{
  "repository": "https://github.com/microsoft/onnxruntime.git",
  "default_version": "1.29.0",
  "revisions": {"1.29.0": "<full Microsoft commit>"}
}
```

The CLI assembles that lock with every recipe's definitions and emits the
fully resolved catalog through `list targets --json`.

## Verification is evidence, not syntax

`verified` means Wfloat has a completed artifact that passes the documented
package and consumer-oriented checks for that contract; it does not claim that
every provider ran on its target hardware. `unverified` means a recipe and
contract are implemented, but command-plan generation is the only universal
evidence currently available. The CLI displays and enforces this distinction
by warning before an unverified build. Automatic CI coverage is a separate
policy: it may build an unverified target specifically to gather the evidence
needed for later promotion, but a workflow entry does not change the catalog's
verification state.

At Microsoft v1.29.0, the verified targets are the combined Android shared
package, iOS static XCFramework, and `wasm-static_lib-simd`. The other accepted
targets remain unverified until a real build and proportional consumer check
complete.

ROCm is not an accepted target at this lock: Microsoft's source has neither
the ROCm provider directory nor `--use_rocm`, and MIGraphX is not a substitute.
OpenHarmony is also not accepted: this source has no Microsoft OpenHarmony
build path, and Wfloat has neither an independent completed implementation nor
artifact evidence. These limitations are documentation, not decorative target
fields that a build silently ignores.

## WebAssembly compatibility decisions

Microsoft's Release WebAssembly configuration normally adds `-flto` even when
its general LTO option is off. Wfloat supplies later Release `-fno-lto` flags
because Sherpa performs the final Emscripten link. Package validation extracts
an archive member and rejects LLVM bitcode in place of a WebAssembly object.

Exception catching remains enabled. Microsoft v1.29.0 maps
`onnxruntime_ENABLE_WEBASSEMBLY_EXCEPTION_CATCHING=ON` to Emscripten's
`DISABLE_EXCEPTION_CATCHING=0`; the recipe now passes that CMake choice
explicitly and verifies the mapping in the exact Microsoft source. Emscripten
defines the setting for both compile and link, so Wfloat's real Sherpa final
link now carries the same option. That consumer currently pins Emscripten 4.0.8
while Microsoft's v1.29.0 archive recipe uses 4.0.23; the completed Sherpa
combined-speech link is the compatibility evidence between those exact roles.
The C API smoke also enables catching. SIMD is enabled and threads remain off
for Wfloat's demonstrated browser dependency.

Build invocations also set CMake's policy compatibility minimum to 3.5. This
lets current CMake configure legacy third-party dependency declarations such
as XNNPACK's psimd project without modifying Microsoft-selected sources.

## CI and publication

CI selection is deliberately file-based. A recipe file selects every automatic
target owned by that recipe. A source-lock or genuinely shared build/source/
package change selects all automatic targets. Validator, test, and
documentation changes run the contract suite without recompiling targets. The
small set of live Sherpa/Emscripten files that defines the later WebAssembly
link selects only `wasm-static_lib-simd`.

The automatic set follows Wfloat's current consumers: combined Android shared,
iOS static XCFramework, Wasm SIMD static, Linux x86-64/AArch64 shared with the
glibc 2.17 floor, macOS arm64/x86-64 static, and Windows x64 static with `/MT`.
The two Linux targets run inside the same manylinux2014 environment family used
by Wfloat's wheel matrix. The exact architecture-specific container manifests
are pinned in `ci/run_target.py`, preventing a moving image tag from silently
changing the compiler or sysroot. Each architecture is a separate job so native
tests can run where applicable and one 14 GB runner does not hold multiple
architecture build trees.

Workflows keep read-only repository permissions and the existing pull-request
approval model. They contain no registry credentials. A completed archive is
revalidated in the same job and then removed from the runner; GitHub Actions
does not store it as a workflow artifact. Registry publication remains a
separate Wfloat operation after the exact archive passes its real downstream
consumer contract and receives explicit approval.

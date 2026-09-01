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
plans in `onnxruntime_build/recipes/`: Android, Apple XCFramework, macOS
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

At Microsoft v1.29.0, the only verified target is the combined Android shared
package. The Apple targets require new artifact evidence under the exact Xcode
16.4 build 16F6 contract, and `wasm-static_lib-simd` likewise remains
unverified. Every accepted unverified target requires a real build and
proportional consumer check at a committed Wfloat revision before promotion.

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

Exception catching remains disabled. The recipe passes Microsoft's
`--disable_wasm_exception_catching` option, and Sherpa's final link leaves
Emscripten's disabled-by-default mode unchanged. That consumer currently pins
Emscripten 4.0.8 and a published ONNX Runtime 1.23.2 archive, while Microsoft's
v1.29.0 archive recipe uses Emscripten 4.0.23. The v1.29.0 target remains
unverified. Promoting it requires a deliberate artifact build and review,
immutable publication, an explicit consumer URL/hash update, and the affected
Web consumer validation. SIMD is enabled and threads remain off for the
intended browser dependency.

Build invocations also set CMake's policy compatibility minimum to 3.5. This
lets current CMake configure legacy third-party dependency declarations such
as XNNPACK's psimd project without modifying Microsoft-selected sources.

## CI and publication

CI is divided into a contract workflow and five build families: Android,
Apple, Linux, Windows, and WebAssembly. Each build workflow declares its own
fixed hosted runner, platform setup, and small target matrix. A recipe change
therefore triggers only a family with an automatic target owned by that recipe,
while source-lock or genuinely shared build/source/package changes trigger all
five families. The ordered path filters first include all shared
`onnxruntime_build` modules, then exclude every recipe, and finally reinclude
only the family's recipe modules. Consequently a validator change triggers all
families, while an unrelated recipe change does not. The shared composite-action
directory also triggers every family so a future helper placed there cannot be
missed. Tests and documentation run the contract suite without recompiling
targets. Downstream Sherpa, llama, and Web package changes remain the
responsibility of Wfloat Web CI, which consumes the exact published ONNX
Runtime URL and checksum committed in Sherpa's CMake configuration. They do not
trigger an ONNX Runtime rebuild.

The automatic set is an intended migration and evidence matrix: combined
Android shared, iOS static XCFramework, Wasm SIMD static, Linux
x86-64/AArch64 shared with the glibc 2.17 floor, macOS arm64/x86-64 static, and
Windows x64 static with `/MT`. Some live consumers still pin older artifacts,
so this list must not be read as a statement that every consumer already uses
v1.29.0. The two Linux targets run inside the same manylinux2014 environment
family used by Wfloat's wheel matrix. Their exact architecture-specific
container manifests, GNU GCC 11.4.0 source URL, and GNU-published SHA-512 are
cataloged with the Linux recipe and consumed by `ci/run_target.py`. GNU
binutils 2.42, its official release URL, and the SHA-512 derived after verifying
GNU's detached release signature are cataloged alongside GCC. Both are built
from verified GNU releases inside the ephemeral container as the hosted
runner's unprivileged UID/GID, and GCC is bound to the pinned assembler and
linker. The host wrapper proves the executable builder paths are clean before
the repository-owned installer runs, and the public launcher checks them again
inside the container. The recipe verifies the exact versions and prefix paths
of every compiler and binutils program exported to the build, C++20 library
support, the required AArch64 assembler modes, and forced
AVX-VNNI assembly/disassembly on x86-64. Package validation independently
enforces the
architecture-specific manylinux symbol, forbidden-symbol, and direct-dependency
policy. Each architecture is a separate job so one 14 GB runner does not hold
multiple architecture build trees.

Apple jobs select `/Applications/Xcode_16.4.app/Contents/Developer` and require
Xcode 16.4 build 16F6 on both `macos-15` arm64 and `macos-15-intel`. Windows
uses `windows-2022`, initializes the Visual Studio 2022 x64 developer
environment, and proves `cl.exe` and `dumpbin.exe` are available before the
build. These checks fail closed if hosted-runner toolchains drift.

The automatic macOS static-library builds preserve a macOS 11.0 deployment
floor and use package-only validation. Microsoft unit-test targets are not
built because ONNX Runtime v1.29.0's test-only Xcode 16.4 standard-library path
requires macOS 13.3. This exception does not alter the runtime sources or raise
the artifact floor. It is independent of the Linux exception below and does not
apply to Windows CPU builds.
The completed macOS archive must still pass architecture, linkage,
minimum-platform, package, and basic C API compile/link/run validation.

The automatic glibc 2.17 Linux builds also use package-only validation. ONNX
Runtime v1.29.0 gives one unit-test target an include path where its private
`endian.h` shadows glibc 2.17's system header; compiling that test target fails
before it can validate the shipped library. Wfloat does not patch Microsoft's
test source or include ordering. It omits all Microsoft unit-test targets while
retaining full runtime compilation and Wfloat's package, ELF ABI/dependency,
and C API compile/link/run validation. Native glibc 2.28 and Windows CPU
targets retain their `native` policy.

Each family workflow can also be dispatched manually, but exposes no target,
runner, version, source-revision, or test-policy input. Manual execution is thus
bounded by the same committed source lock, target set, toolchain, and validation
path as automatic execution.

Workflows keep read-only repository permissions and the existing pull-request
approval model. External actions are pinned to immutable commits, and workflows
contain no registry credentials. A completed archive is revalidated in the
same job, uploaded for three days of inspection, and removed from the runner.
Registry publication remains a separate Wfloat operation requiring explicit
approval. Consumer URL/hash changes and their validation belong to that
deliberate promotion process rather than ordinary builder CI.

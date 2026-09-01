# Target catalog reference

Target definitions live in the platform modules under
`onnxruntime_build/recipes/`. [`source-lock.json`](../../source-lock.json)
contains only Microsoft source provenance. Workflows and local commands consume
the same assembled catalog, and this command emits every fully resolved target:

```sh
./tools/onnxruntime-build/onnxruntime-build list targets --json
```

## Source lock fields

| Field | Meaning |
| --- | --- |
| `repository` | Required Microsoft ONNX Runtime Git origin |
| `default_version` | Version used when `--version` is omitted |
| `revisions` | Exact version-to-full-Microsoft-commit map |

The lock intentionally has no target definitions, profiles, or generated
schema metadata.

## Resolved target fields

| Field | Meaning |
| --- | --- |
| `id` | Public command target identifier |
| `family` | Registry/archive family; defaults to `id` |
| `recipe` | Module that owns target data and the Microsoft command plan |
| `verification` | `verified` completed evidence or `unverified` implementation |
| `platform` / `host` | Package platform and required primary build host |
| `architecture` / `architectures` / `slices` | CPU or platform-native slice set |
| `linkage` | `static` or `shared` |
| `providers` | Required ONNX Runtime execution providers |
| `minimum_platform` / `minimum_platforms` | Explicit deployment compatibility |
| `toolchain` | Recipe-enforced SDK/provider versions and required environment |
| `package` | Archive kind, header location, and required library paths |
| `validation` | Microsoft test policy enforced by shared command behavior |
| `features` | Recipe-enforced feature choices, currently used by WebAssembly |

Catalog loading rejects missing required fields, unknown recipe ownership, and
unknown verification or test-policy values. The `validation` object rejects
extra descriptive fields. Recipes consume fields such as toolchain and features
when producing commands; the catalog does not retain old `profile`, `driver`,
or binary-format labels that merely described behavior elsewhere.

## Recipe groups

| Recipe | Related targets | Verification at v1.29.0 |
| --- | --- | --- |
| Android | combined shared plus four per-ABI static packages | combined `android` verified |
| Apple XCFramework | iOS, macOS, and visionOS; static/shared | unverified |
| macOS shared | arm64, x86_64, universal2 | unverified |
| macOS static | arm64, x86_64, universal2 | unverified |
| Linux native | x86-64/AArch64, glibc 2.17/2.28, static/shared | unverified |
| Linux cross/RISC-V | ARM and RISC-V static/shared | unverified |
| CUDA | Linux x86-64/AArch64 and Windows x64, CUDA 12/13 | unverified |
| Windows CPU | x86/x64/arm64, `/MD`/`/MT`, static/shared | unverified |
| Windows ARM64X | two-stage ARM64/ARM64EC shared build | unverified |
| DirectML | Windows x64 shared | unverified |
| WebAssembly | SIMD/threads combinations, static | unverified |

VisionOS resolves providers to CPU and CoreML; it does not inherit XNNPACK.
iOS and macOS retain XNNPACK where Microsoft's Apple builder supports it.
Every Apple target records and enforces Xcode 16.4 build 16F6 at
`/Applications/Xcode_16.4.app/Contents/Developer`.

ROCm and OpenHarmony are not target rows at v1.29.0. ROCm lacks its provider
and Microsoft build flag at the locked commit. OpenHarmony lacks Microsoft
build machinery and completed Wfloat implementation evidence. Consequently the
CLI rejects those identifiers instead of emitting plausible-looking commands.

## Archive identity

For family `<family>`, ONNX Runtime version `<version>`, and the first 12
hexadecimal characters of the committed Wfloat builder revision `<builder>`:

```text
onnxruntime-<family>-<version>-<builder>.zip
└── onnxruntime-<family>-<version>-<builder>/
```

Every archive is a Release package. Non-native bundles use `include/` and
`lib/`, except combined Android, which uses `headers/` and `jni/<abi>/`.
Apple XCFramework targets contain `onnxruntime.xcframework`.

The iOS deployment floor is 13.0. The arm64 simulator architecture may carry a
14.0 Mach-O minimum while x86_64 simulator and arm64 device slices remain at
13.0. Validation thins universal archives and checks each architecture.

The CLI has no arbitrary source-revision override. `--source-dir` accepts only
a Microsoft checkout with no tracked, untracked, or ignored content whose
`HEAD` and recursive submodules match the locked revision. Every archive
contains that source's `LICENSE` and
`ThirdPartyNotices.txt`; there is no checksum, JSON, registry metadata, or
provenance sidecar in the package.

## Test policies

| Policy | Behavior |
| --- | --- |
| `native` | Run Microsoft's applicable tests when target architecture matches the host |
| `cross` | Report Microsoft target tests skipped; validate package metadata and link where possible |
| `gpu-compile` | Build and validate provider files/linkage; report runtime validation separately unless matching hardware is available |
| `package-only` | Do not build Microsoft test targets; require package metadata and available compile/link/run validation |

The validator never converts a skipped test into a pass.

The traditional macOS static-library targets use `package-only`. They preserve
the macOS 11.0 artifact floor instead of compiling Microsoft's v1.29.0 test
executables, whose Xcode 16.4 standard-library path requires floating-point
`std::to_chars` introduced in macOS 13.3. Linux and Windows native CPU targets
remain `native`; this exception does not disable their Microsoft tests.

## Automatic CI evidence targets

Five platform-family workflows build this intended migration and evidence
matrix when shared builder behavior changes:

- `android`
- `ios-static-xcframework`
- `wasm-static_lib-simd`
- `linux-x64-glibc2_17`
- `linux-aarch64-glibc2_17`
- `osx-arm64-static_lib`
- `osx-x86_64-static_lib`
- `win-x64-static_lib-mt`

Some live consumers still pin older artifacts; this matrix is not a claim that
all consumers already use v1.29.0. Ordered workflow filters include future
shared `onnxruntime_build` modules, exclude every recipe, and reinclude only
the owning family's recipes. A validator or other shared-module change therefore
triggers all families, while an unrelated recipe change does not. Tests and
documentation run the separate contract workflow without rebuilding every
platform. Each family workflow also supports input-free manual dispatch, so a
caller cannot substitute a target, runner, version, or source revision. Every
completed archive is revalidated and retained as a GitHub Actions artifact for
three days of inspection.

Being in this list, or completing CI, does not imply `verification: verified`;
completed artifact and proportional consumer evidence must earn that status.

# How to build and validate an ONNX Runtime artifact

Run commands from the public Wfloat repository root. Python 3, Git, CMake, and
the selected platform toolchain must be available. The builder has no Python
package dependencies outside the standard library.

## Choose a target

List target identifiers and their resolved platform, architecture, linkage,
execution-provider, recipe, and verification properties:

```sh
./tools/onnxruntime-build/onnxruntime-build list targets
./tools/onnxruntime-build/onnxruntime-build list targets --platform android
./tools/onnxruntime-build/onnxruntime-build list targets --json
```

`verified` means a completed artifact exists and passed the documented checks
for that contract; it does not mean every provider ran on device or GPU
hardware. `unverified` means the recipe is implemented but has not earned that
evidence. A successful `--plan` does not change this status.

Use `--plan` to inspect the Microsoft build commands without fetching source or
requiring a platform SDK:

```sh
./tools/onnxruntime-build/onnxruntime-build build ios-static-xcframework --plan --jobs 4
```

## Prepare the builder revision

Commit the builder source and its workflows before producing an archive. The
builder refuses a real build if those paths are dirty because the first 12
characters of that Wfloat commit form part of the immutable archive identity.

The source cache, build tree, and archives default to:

```text
tools/onnxruntime-build/.cache/
tools/onnxruntime-build/.build/
tools/onnxruntime-build/.out/
```

They are ignored by Git. Use `--cache-dir`, `--work-dir`, or `--output-dir` to
place them elsewhere.

## Build one target

Build the default cataloged ONNX Runtime revision with a bounded job count:

```sh
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd --jobs 4
```

Every accepted version must have an exact Microsoft commit in the `revisions`
map in `source-lock.json`. To build another version, add its reviewed
version-to-commit mapping and commit that lock change before running the build.
Arbitrary source overrides are not accepted.

Select a cataloged version with `--version`:

```sh
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd \
  --version 1.29.0 \
  --jobs 8
```

An existing checkout is accepted only when its `origin` is Microsoft's ONNX
Runtime repository, its checked-out commit matches the version's committed
lock, its worktree has no tracked, untracked, or ignored content, every
recursive submodule is at the recorded gitlink, and every submodule worktree is
equally clean:

```sh
./tools/onnxruntime-build/onnxruntime-build build wasm-static_lib-simd \
  --version 1.29.0 \
  --source-dir /path/to/microsoft/onnxruntime
```

The build output prints the resolved Microsoft commit, the Wfloat builder
revision, the archive path, validation results, and the archive SHA-256. It does
not create a checksum or provenance sidecar.

The builder-owned cache is sanitized before reuse: ordinary changes cause a
failure, while ignored outputs from an earlier build (including an installed
Emscripten SDK) are removed before the exact-source check. A later Wasm build
therefore reinstalls its locked Microsoft-selected toolchain. A caller-supplied
`--source-dir` is never cleaned automatically.

## Supply platform toolchains

The `revisions` map in `source-lock.json` is authoritative for versions. When a
recipe exposes toolchain versions or required environment variables in
`list targets --json`, its preflight and command generation enforce them.
Target definitions live in their owning modules under
`onnxruntime_build/recipes/`.

### Android

Set the Android SDK and NDK roots. The default catalog uses NDK
`28.0.13004108`, Android API 21, and NNAPI API 27:

```sh
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/28.0.13004108"
./tools/onnxruntime-build/onnxruntime-build build android --jobs 4
```

The combined package builds all four ABIs. Static Android targets build one
cataloged ABI.

### Apple

Run Apple targets on macOS with Xcode 16.4 build 16F6 selected at the cataloged
developer directory:

```sh
export DEVELOPER_DIR=/Applications/Xcode_16.4.app/Contents/Developer
xcodebuild -version
```

The builder preflight requires that exact selection. It uses Microsoft's Apple
framework assembler for XCFramework and traditional static packages. iOS
device and simulator slices are built with an explicit 13.0 deployment target.

### Linux glibc targets

Run each glibc family in a matching cataloged glibc environment. The command
rejects a native host whose glibc version does not equal the target environment.
For x86-64 and AArch64 shared packages, validation applies the
architecture-specific manylinux symbol allow-set for `GLIBC`, `GLIBCXX`,
`CXXABI`, `GCC`, `LIBATOMIC`, and `ZLIB`. It also rejects direct ELF
dependencies outside the corresponding manylinux system-library allowlist and
undefined symbols forbidden by the policy. Wfloat's glibc 2.17 AArch64 contract
deliberately rejects `GLIBC_2.18` even though current auditwheel policy has an
architecture-specific exception for it.

When rejecting a mismatched host, the recipe names the standard manylinux
container for that x86-64 or AArch64 glibc 2.17/2.28 build. Run the same public
command inside that container; do not copy package contents from another
distributor.

The two automatic glibc 2.17 jobs use architecture-matched manylinux2014 images
pinned by manifest digest. Inside each image, `ci/run_target.py` installs the
PyPA-cataloged static-Clang release `v21.1.8.1` through PyPA's
checksum-verifying helper and pins the helper's `sha256sums.txt` digest. The
build uses Clang/LLVM 21.1.8,
LLVM's archiver and LLD, while retaining the image's glibc 2.17 sysroot and GCC
10 libstdc++/libgcc compatibility runtime. Before Microsoft configure runs, the
recipe requires those exact tool versions, performs a C++ compile/link probe,
and on AArch64 separately proves both `-march=armv8.2-a+bf16` and
`-march=armv8.2-a+fp16`. This satisfies ONNX Runtime's compiler and assembler
requirements without replacing the compatibility runtime. The completed ELF
still has to pass the symbol and dependency policy; the selected compiler is
not treated as proof of runtime compatibility.

For a cross-compiled ARM or AArch64 build, provide target compilers, an exact
sysroot, and a host `protoc`:

```sh
export CC=/path/to/target-gcc
export CXX=/path/to/target-g++
export AR=/path/to/target-ar
export WFLOAT_LINUX_SYSROOT=/path/to/target-sysroot
export WFLOAT_PROTOC=/path/to/host/protoc
```

RISC-V uses Microsoft's `--rv64` entry point and requires
`RISCV_TOOLCHAIN_ROOT` and `WFLOAT_PROTOC`. The glibc 2.17 shared target's
toolchain root must contain a glibc 2.17 sysroot.

### CUDA and DirectML

CUDA targets require `CUDA_HOME` and `CUDNN_HOME`. CUDA 12 targets require CUDA
12.8 and cuDNN 9.10.2; CUDA 13 targets require CUDA 13.0 and cuDNN 9.14.0.
Preflight checks `nvcc` and cuDNN's version header rather than accepting a
different installed toolkit. TensorRT is disabled in these families. GPU
runtime tests are reported separately and run only on matching hardware.

DirectML uses the dependency version pinned by the selected Microsoft source
revision and packages its required runtime DLL.

ROCm is unavailable at the v1.29.0 source lock. Microsoft removed the provider
directory and `--use_rocm`; MIGraphX is a different provider. There is no ROCm
target to select.

### Windows

Run Windows builds from a Visual Studio 2022 x64 developer environment. The
locked Microsoft source defaults to its `Visual Studio 17 2022` generator, and
the family workflow uses `windows-2022` and verifies both `cl.exe` and
`dumpbin.exe` before the build. The target's `-md` or `-mt` suffix selects
Microsoft's default dynamic MSVC runtime or its
`--enable_msvc_static_runtime` option. ARM64X uses Microsoft's documented
two-stage ARM64 then ARM64EC build.

### WebAssembly

Microsoft’s build entry point installs and activates Emscripten 4.0.23 for the
ONNX Runtime archive. Wfloat's live Sherpa consumer links with its independently
pinned Emscripten 4.0.8. Wfloat's bootstrap checks out the official emsdk at
exact commit `419021fa040428bc69ef1559b325addb8e10211f`, refuses a modified or
wrong-origin managed cache, and requires the compiler to report exactly
`4.0.8`. The consumer currently pins a published ONNX Runtime 1.23.2 archive.
SIMD and threads are controlled independently by the target. The builder uses
Microsoft's `--disable_wasm_exception_catching` option and never enables
archive-level LTO. Sherpa's final link does not override Emscripten's
disabled-by-default exception-catching mode. The v1.29.0
`wasm-static_lib-simd` contract remains unverified pending a successful
committed-revision consumer run and reviewed evidence.

### OpenHarmony

OpenHarmony is unavailable at the v1.29.0 source lock. The exact Microsoft
source provides no OpenHarmony build path, and Wfloat has no completed
independent implementation or artifact evidence. There is no OpenHarmony
target to select.

## Validate an existing archive

Use the same target identifier that built the package:

```sh
./tools/onnxruntime-build/onnxruntime-build validate \
  linux-x64-glibc2_17 \
  tools/onnxruntime-build/.out/onnxruntime-linux-x64-glibc2_17-1.29.0-0123456789ab.zip
```

Validation checks archive identity and extraction safety, the single top-level
directory, notices, headers, required core/provider libraries, architecture,
ABI, linkage, minimum-platform metadata, Linux symbol-version and dependency
policy or Windows CRT metadata where applicable, and a C API compile/link smoke
when the runner can exercise the target.

Use `--skip-smoke` only when the target cannot be linked on the validation
runner. The command records that step as skipped; it does not report a pass.

For a WebAssembly archive, activate Wfloat's live consumer toolchain and run
validation without treating the generated SDK as pristine Microsoft source:

```sh
source ./scripts/ensure-emscripten.sh
./tools/onnxruntime-build/onnxruntime-build validate \
  wasm-static_lib-simd \
  path/to/onnxruntime-wasm-static_lib-simd-1.29.0-0123456789ab.zip
```

This supplies Emscripten 4.0.8 `llvm-ar` and `em++` for object inspection and
the final-link smoke test. `--source-dir` remains available for a pristine
Microsoft checkout, but a checkout containing an installed ignored SDK is
deliberately rejected as exact source.

## CI retention policy

The contract, Android, Apple, Linux, Windows, and WebAssembly workflows are
separate so each platform family owns fixed hosted runners and a small target
set. Family workflows can be manually dispatched without accepting a target,
runner, version, or source-revision override; the committed source lock remains
authoritative.

Automatic builds form Wfloat's intended migration and evidence matrix for
Android, iOS, Web, Linux x86-64/AArch64, macOS arm64/x86-64, and Windows x64.
Some live consumers still pin older artifacts, so membership is not a claim of
current deployment or verification. The glibc 2.17 Linux builds run in
architecture-matched manylinux2014 containers. Their exact manifests are pinned
with the Linux recipe and consumed by `ci/run_target.py`; changing an image,
compiler release, or installer checksum is therefore a reviewable source change
rather than an implicit consequence of a moving tag. Each build revalidates its
completed zip, uploads it to GitHub Actions with three-day retention, and then
removes `.out` from the runner. Publication to Wfloat's immutable R2 registry
remains a separate, explicitly approved operation.

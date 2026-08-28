# How to build and validate an ONNX Runtime artifact

Run commands from the public Wfloat repository root. Python 3, Git, CMake, and
the selected platform toolchain must be available. The builder has no Python
package dependencies outside the standard library.

## Choose a target

List target identifiers and their resolved platform, architecture, linkage,
execution-provider, recipe, and verification properties:

```sh
./tools/onnxruntime-build/ort-builder list targets
./tools/onnxruntime-build/ort-builder list targets --platform android
./tools/onnxruntime-build/ort-builder list targets --json
```

`verified` means a completed artifact exists and passed the documented checks
for that contract; it does not mean every provider ran on device or GPU
hardware. `unverified` means the recipe is implemented but has not earned that
evidence. A successful `--plan` does not change this status.

Use `--plan` to inspect the Microsoft build commands without fetching source or
requiring a platform SDK:

```sh
./tools/onnxruntime-build/ort-builder build ios-static-xcframework --plan --jobs 4
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
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd --jobs 4
```

Every accepted version must have an exact Microsoft commit in the `revisions`
map in `source-lock.json`. To build another version, add its reviewed
version-to-commit mapping and commit that lock change before running the build.
Arbitrary source overrides are not accepted.

Select a cataloged version with `--version`:

```sh
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd \
  --version 1.29.0 \
  --jobs 8
```

An existing checkout is accepted only when its `origin` is Microsoft's ONNX
Runtime repository, its checked-out commit matches the version's committed
lock, its worktree has no tracked, untracked, or ignored content, every
recursive submodule is at the recorded gitlink, and every submodule worktree is
equally clean:

```sh
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd \
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
`onnxruntime_builder/recipes/`.

### Android

Set the Android SDK and NDK roots. The default catalog uses NDK
`28.0.13004108`, Android API 21, and NNAPI API 27:

```sh
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/28.0.13004108"
./tools/onnxruntime-build/ort-builder build android --jobs 4
```

The combined package builds all four ABIs. Static Android targets build one
cataloged ABI.

### Apple

Run Apple targets on macOS with suitable Xcode SDKs available. The builder
uses Microsoft's Apple framework assembler for XCFramework and traditional
static packages. iOS device and simulator slices are built with an explicit
13.0 deployment target.

### Linux glibc targets

Run each glibc family in a matching cataloged glibc environment. The command
rejects a native host whose glibc version does not equal the target environment.
Shared-package validation also reads symbol-version metadata and rejects a
library whose required glibc version is too new.

When rejecting a mismatched host, the recipe names the standard manylinux
container for that x86-64 or AArch64 glibc 2.17/2.28 build. Run the same public
command inside that container; do not copy package contents from another
distributor.

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

Run Windows builds from a Visual Studio developer environment. The target's
`-md` or `-mt` suffix selects Microsoft's default dynamic MSVC runtime or its
`--enable_msvc_static_runtime` option. ARM64X uses Microsoft's documented
two-stage ARM64 then ARM64EC build.

### WebAssembly

Microsoft's build entry point installs and activates Emscripten 4.0.23 for the
ONNX Runtime archive. Wfloat's live Sherpa consumer links with its independently
pinned Emscripten 4.0.8. SIMD and threads are controlled independently by the
target. The builder explicitly keeps exception catching enabled for ONNX
Runtime's static objects and never enables archive-level LTO. Because Emscripten
defines exception catching as a compile-and-link setting, Sherpa's real final
link now explicitly uses `-sDISABLE_EXCEPTION_CATCHING=0`; validation uses the
same setting.

### OpenHarmony

OpenHarmony is unavailable at the v1.29.0 source lock. The exact Microsoft
source provides no OpenHarmony build path, and Wfloat has no completed
independent implementation or artifact evidence. There is no OpenHarmony
target to select.

## Validate an existing archive

Use the same target identifier that built the package:

```sh
./tools/onnxruntime-build/ort-builder validate \
  linux-x64-glibc2_17 \
  tools/onnxruntime-build/.out/onnxruntime-linux-x64-glibc2_17-1.29.0-0123456789ab.zip
```

Validation checks archive identity and extraction safety, the single top-level
directory, notices, headers, required core/provider libraries, architecture,
ABI, linkage, minimum-platform metadata, glibc or CRT metadata where
applicable, and a C API compile/link smoke when the runner can exercise the
target.

Use `--skip-smoke` only when the target cannot be linked on the validation
runner. The command records that step as skipped; it does not report a pass.

For a WebAssembly archive, activate Wfloat's live consumer toolchain and run
validation without treating the generated SDK as pristine Microsoft source:

```sh
source ./scripts/ensure-emscripten.sh
./tools/onnxruntime-build/ort-builder validate \
  wasm-static_lib-simd \
  path/to/onnxruntime-wasm-static_lib-simd-1.29.0-0123456789ab.zip
```

This supplies Emscripten 4.0.8 `llvm-ar` and `em++` for object inspection and
the final-link smoke test. `--source-dir` remains available for a pristine
Microsoft checkout, but a checkout containing an installed ignored SDK is
deliberately rejected as exact source.

## CI retention policy

Builder workflows automatically cover Wfloat's current Android, iOS, Web,
Linux x86-64/AArch64, macOS arm64/x86-64, and Windows x64 artifact contracts.
The glibc 2.17 Linux builds run in architecture-matched manylinux2014
containers. Their exact manifests are pinned in `ci/run_target.py`; changing a
Linux build environment is therefore a reviewable source change rather than an
implicit consequence of a moving image tag. Each workflow validates the
completed zip and then removes `.out` from the runner. It does not upload the
zip to GitHub Actions. Publication to Wfloat's immutable R2 registry remains a
separate, explicitly approved operation.

# How to build and validate an ONNX Runtime artifact

Run commands from the public Wfloat repository root. Python 3, Git, CMake, and
the selected platform toolchain must be available. The builder has no Python
package dependencies outside the standard library.

## Choose a target

List target identifiers and their resolved platform, architecture, linkage,
and execution-provider properties:

```sh
./tools/onnxruntime-build/ort-builder list targets
./tools/onnxruntime-build/ort-builder list targets --platform android
./tools/onnxruntime-build/ort-builder list targets --json
```

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

Build the default `v1.29.0` Microsoft tag with a bounded job count:

```sh
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd --jobs 4
```

Build another exact tag:

```sh
./tools/onnxruntime-build/ort-builder build linux-x64-glibc2_17 \
  --version 1.30.0 \
  --jobs 8
```

To build an explicitly reviewed Microsoft commit, provide the version used in
the package identity and a full 40-character commit:

```sh
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd \
  --version 1.29.0 \
  --source-ref 0123456789abcdef0123456789abcdef01234567
```

An existing checkout is accepted only when its `origin` is Microsoft's ONNX
Runtime repository and its checked-out commit matches the requested tag or
commit:

```sh
./tools/onnxruntime-build/ort-builder build wasm-static_lib-simd \
  --version 1.29.0 \
  --source-dir /path/to/microsoft/onnxruntime
```

The build output prints the resolved Microsoft commit, the Wfloat builder
revision, the archive path, validation results, and the archive SHA-256. It does
not create a checksum or provenance sidecar.

## Supply platform toolchains

The resolved target definition from `list targets --json` is authoritative for
versions and required environment variables.

### Android

Set the Android SDK and NDK roots. The default catalog uses NDK
`26.1.10909125`, Android API 21, and NNAPI API 27:

```sh
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
./tools/onnxruntime-build/ort-builder build android --jobs 4
```

The combined package builds all four ABIs. Static Android targets build one
cataloged ABI.

### Apple

Run Apple targets on macOS with the cataloged Xcode SDKs available. The builder
uses Microsoft's Apple framework assembler for XCFramework and traditional
static packages. iOS device and simulator slices are built with an explicit
13.0 deployment target.

### Linux glibc targets

Run each glibc family in the exact build environment named in `targets.json`.
The command rejects a native host whose glibc version does not equal the target
environment. Shared-package validation also reads symbol-version metadata and
rejects a library whose required glibc version is too new.

The catalog identifies the standard manylinux container for x86-64 and AArch64
glibc 2.17 and 2.28 builds. Run the same public command inside that container;
do not copy package contents from another distributor.

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

### CUDA, ROCm, and DirectML

CUDA targets require `CUDA_HOME` and `CUDNN_HOME`. CUDA 12 targets require CUDA
12.8 and cuDNN 9.10.2; CUDA 13 targets require CUDA 13.0 and cuDNN 9.14.0.
Preflight checks `nvcc` and cuDNN's version header rather than accepting a
different installed toolkit. TensorRT is disabled in these families. GPU
runtime tests are reported separately and run only on matching hardware.

The `linux-x64-rocm` identity is reserved for the ROCm execution provider.
The builder verifies that the selected Microsoft revision actually contains
that provider and its build flag. It fails instead of substituting MIGraphX.

DirectML uses the dependency version pinned by the selected Microsoft source
revision and packages its required runtime DLL.

### Windows

Run Windows builds from a Visual Studio developer environment. The target's
`-md` or `-mt` suffix selects Microsoft's default dynamic MSVC runtime or its
`--enable_msvc_static_runtime` option. ARM64X uses Microsoft's documented
two-stage ARM64 then ARM64EC build.

### WebAssembly

Microsoft's build entry point installs and activates the cataloged Emscripten
SDK. SIMD and threads are controlled independently by the target. The builder
never enables archive-level LTO, and validation attempts a final Emscripten C
API link.

### OpenHarmony

Set `OHOS_NDK_HOME` to an OpenHarmony native SDK containing
`build/cmake/ohos.toolchain.cmake`. The target passes the cataloged ABI and API
level through that platform toolchain while retaining Microsoft's build entry
point.

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

For a WebAssembly archive, either activate the cataloged Emscripten SDK or
point validation at the Microsoft checkout that installed it:

```sh
./tools/onnxruntime-build/ort-builder validate \
  wasm-static_lib-simd \
  path/to/onnxruntime-wasm-static_lib-simd-1.29.0-0123456789ab.zip \
  --source-dir tools/onnxruntime-build/.cache/sources/onnxruntime-1.29.0
```

This lets validation use the matching `llvm-ar` and `em++` for object-format
inspection and the final-link smoke test.

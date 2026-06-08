#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"

BUILD_ROOT="${REPO_ROOT}/out"
DEVICE_BUILD_DIR="${BUILD_ROOT}/rn-llm-ios-device-static"
SIM_ARM64_BUILD_DIR="${BUILD_ROOT}/rn-llm-ios-sim-static"
SIM_X86_64_BUILD_DIR="${BUILD_ROOT}/rn-llm-ios-sim-x86_64-static"
PACKAGE_BUILD_DIR="${BUILD_ROOT}/rn-llm-ios"
DEVICE_OUT_DIR="${PACKAGE_BUILD_DIR}/device"
SIM_ARM64_OUT_DIR="${PACKAGE_BUILD_DIR}/sim-arm64"
SIM_X86_64_OUT_DIR="${PACKAGE_BUILD_DIR}/sim-x86_64"
SIM_UNIVERSAL_OUT_DIR="${PACKAGE_BUILD_DIR}/simulator"
XCFRAMEWORK_DIR="${PACKAGE_BUILD_DIR}/wfloat-core-llm.xcframework"
HEADERS_DIR="${REPO_ROOT}/native/wfloat-core/include"

IOS_DEPLOYMENT_TARGET="${WFLOAT_IOS_DEPLOYMENT_TARGET:-13.4}"
BUILD_JOBS="${WFLOAT_BUILD_JOBS:-4}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required to build wfloat-core-llm.xcframework." >&2
    exit 1
  fi
}

build_slice() {
  local label="$1"
  local build_dir="$2"
  local sdk="$3"
  local arch="$4"

  echo "Building wfloat-core LLM for ${label}..."
  cmake \
    -S "${REPO_ROOT}" \
    -B "${build_dir}" \
    -G Xcode \
    -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="${sdk}" \
    -DCMAKE_OSX_ARCHITECTURES="${arch}" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${IOS_DEPLOYMENT_TARGET}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWFLOAT_BUILD_CORE=ON \
    -DWFLOAT_ENABLE_LLAMA_CPP=ON \
    -DWFLOAT_CORE_ENABLE_SPEECH=OFF \
    -DLLAMA_BUILD_COMMON=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_TOOLS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=OFF \
    -DLLAMA_BUILD_APP=OFF \
    -DLLAMA_BUILD_UI=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DGGML_BLAS=ON \
    -DGGML_BLAS_VENDOR=Apple \
    -DGGML_METAL=OFF \
    -DGGML_VULKAN=OFF \
    -DGGML_OPENCL=OFF \
    -DGGML_LLAMAFILE=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF

  cmake --build "${build_dir}" \
    --config Release \
    --target wfloat-core \
    --parallel "${BUILD_JOBS}"
}

require_library() {
  local path="$1"

  if [[ ! -f "${path}" ]]; then
    echo "Missing expected static library: ${path}" >&2
    exit 1
  fi
}

combine_slice_libraries() {
  local build_dir="$1"
  local config_dir="$2"
  local out_dir="$3"
  local output_lib="${out_dir}/libwfloat-core-llm.a"

  local libs=(
    "${build_dir}/native/wfloat-core/${config_dir}/libwfloat-core.a"
    "${build_dir}/vendor/llama.cpp/src/${config_dir}/libllama.a"
    "${build_dir}/vendor/llama.cpp/ggml/src/${config_dir}/libggml.a"
    "${build_dir}/vendor/llama.cpp/ggml/src/${config_dir}/libggml-base.a"
    "${build_dir}/vendor/llama.cpp/ggml/src/${config_dir}/libggml-cpu.a"
    "${build_dir}/vendor/llama.cpp/ggml/src/ggml-blas/${config_dir}/libggml-blas.a"
  )

  mkdir -p "${out_dir}"
  for lib in "${libs[@]}"; do
    require_library "${lib}"
  done

  rm -f "${output_lib}"
  libtool -static -o "${output_lib}" "${libs[@]}"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS LLM XCFramework builds require macOS." >&2
  exit 1
fi

require_command cmake
require_command libtool
require_command lipo
require_command xcodebuild

build_slice "iOS device arm64" "${DEVICE_BUILD_DIR}" iphoneos arm64
build_slice "iOS simulator arm64" "${SIM_ARM64_BUILD_DIR}" iphonesimulator arm64
build_slice "iOS simulator x86_64" "${SIM_X86_64_BUILD_DIR}" iphonesimulator x86_64

combine_slice_libraries "${DEVICE_BUILD_DIR}" Release-iphoneos "${DEVICE_OUT_DIR}"
combine_slice_libraries "${SIM_ARM64_BUILD_DIR}" Release-iphonesimulator "${SIM_ARM64_OUT_DIR}"
combine_slice_libraries "${SIM_X86_64_BUILD_DIR}" Release-iphonesimulator "${SIM_X86_64_OUT_DIR}"

mkdir -p "${SIM_UNIVERSAL_OUT_DIR}"
rm -f "${SIM_UNIVERSAL_OUT_DIR}/libwfloat-core-llm.a"
lipo -create \
  "${SIM_ARM64_OUT_DIR}/libwfloat-core-llm.a" \
  "${SIM_X86_64_OUT_DIR}/libwfloat-core-llm.a" \
  -output "${SIM_UNIVERSAL_OUT_DIR}/libwfloat-core-llm.a"

rm -rf "${XCFRAMEWORK_DIR}"
xcodebuild -create-xcframework \
  -library "${DEVICE_OUT_DIR}/libwfloat-core-llm.a" -headers "${HEADERS_DIR}" \
  -library "${SIM_UNIVERSAL_OUT_DIR}/libwfloat-core-llm.a" -headers "${HEADERS_DIR}" \
  -output "${XCFRAMEWORK_DIR}"

echo "Built ${XCFRAMEWORK_DIR}"

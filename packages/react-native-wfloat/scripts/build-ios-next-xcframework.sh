#!/usr/bin/env bash
# Build one ABI-compatible archive for both legacy and redesigned native APIs.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$package_dir/../.." && pwd)"
build_root="$package_dir/ios/build/next-runtime"
jobs="${WFLOAT_BUILD_JOBS:-4}"
deployment="${WFLOAT_IOS_DEPLOYMENT_TARGET:-15.1}"
mkdir -p "$build_root/headers/wfloat-next"
cp -R "$repo_dir/native/wfloat-core/include/wfloat-core" "$build_root/headers/"
cp "$package_dir/cpp/NextRuntime.h" "$build_root/headers/wfloat-next/NextRuntime.h"
build_slice() {
  local label="$1" sdk="$2" arch="$3" build_dir="$build_root/$1"
  cmake -S "$package_dir/cpp" -B "$build_dir" -G "Unix Makefiles" \
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$(xcrun --sdk "$sdk" --show-sdk-path)" \
    -DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET="$deployment" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DWFLOAT_NEXT_INCLUDE_LEGACY_LLM=ON -DWFLOAT_NEXT_TESTS=OFF \
    -DLLAMA_OPENSSL=OFF -DLLAMA_CURL=OFF -DLLAMA_SUBPROCESS=OFF \
    -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
    -DGGML_ACCELERATE_NEW_LAPACK=OFF -DGGML_LLAMAFILE=OFF
  cmake --build "$build_dir" --target wfloat-next-runtime --parallel "$jobs"
  local libs=(
    "$build_dir/libwfloat-next-runtime.a"
    "$build_dir/llama/common/libllama-common.a"
    "$build_dir/llama/common/libllama-common-base.a"
    "$build_dir/llama/src/libllama.a"
    "$build_dir/llama/ggml/src/libggml.a"
    "$build_dir/llama/ggml/src/libggml-base.a"
    "$build_dir/llama/ggml/src/libggml-cpu.a"
    "$build_dir/llama/vendor/cpp-httplib/libcpp-httplib.a"
  )
  for lib in "${libs[@]}"; do test -f "$lib" || { echo "Missing archive: $lib" >&2; exit 1; }; done
  xcrun libtool -static -o "$build_dir/libwfloat-core-llm.a" "${libs[@]}"
}
build_slice sim-arm64 iphonesimulator arm64
build_slice device iphoneos arm64
build_slice sim-x86_64 iphonesimulator x86_64
mkdir -p "$build_root/simulator"
xcrun lipo -create "$build_root/sim-arm64/libwfloat-core-llm.a" "$build_root/sim-x86_64/libwfloat-core-llm.a" -output "$build_root/simulator/libwfloat-core-llm.a"
# Replace the staged framework only after every required slice built successfully.
rm -rf "$build_root/wfloat-core-llm.xcframework"
xcodebuild -create-xcframework \
  -library "$build_root/device/libwfloat-core-llm.a" -headers "$build_root/headers" \
  -library "$build_root/simulator/libwfloat-core-llm.a" -headers "$build_root/headers" \
  -output "$build_root/wfloat-core-llm.xcframework"
rm -rf "$package_dir/ios/wfloat-core-llm.xcframework"
cp -R "$build_root/wfloat-core-llm.xcframework" "$package_dir/ios/wfloat-core-llm.xcframework"
echo "Staged combined legacy/new iOS runtime."

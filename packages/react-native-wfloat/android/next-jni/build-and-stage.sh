#!/usr/bin/env bash
# Checkout-only publisher step. All dependency sources/libraries must exist.
set -euo pipefail
android_dir="$(cd "$(dirname "$0")/.." && pwd)"
android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
android_ndk="${ANDROID_NDK_HOME:-$android_sdk/ndk/26.1.10909125}"
find_build_tool() {
  local name="$1" override="$2" bundled="$android_sdk/cmake/3.22.1/bin/$1"
  if [ -n "$override" ]; then
    command -v "$override"
  elif [ -x "$bundled" ]; then
    echo "$bundled"
  else
    command -v "$name"
  fi
}
cmake_bin="$(find_build_tool cmake "${CMAKE_BIN:-}")" || { echo "CMake not found; install it or set CMAKE_BIN" >&2; exit 1; }
ninja_bin="$(find_build_tool ninja "${NINJA_BIN:-}")" || { echo "Ninja not found; install it or set NINJA_BIN" >&2; exit 1; }
case "$(uname -s)" in Darwin) ndk_host=darwin-x86_64 ;; Linux) ndk_host=linux-x86_64 ;; *) echo "Unsupported build host" >&2; exit 1 ;; esac
strip_bin="$android_ndk/toolchains/llvm/prebuilt/$ndk_host/bin/llvm-strip"
if [ "$#" -eq 0 ]; then set -- arm64-v8a armeabi-v7a x86_64 x86; fi
for abi in "$@"; do
  case "$abi" in arm64-v8a|armeabi-v7a|x86_64|x86) ;; *) echo "Invalid ABI: $abi" >&2; exit 1 ;; esac
  build_dir="$android_dir/build/next-native/$abi"
  args=("-DCMAKE_POSITION_INDEPENDENT_CODE=ON")
  if [ -n "${WFLOAT_SHERPA_DEPS_DIR:-}" ]; then args+=("-DWFLOAT_SHERPA_DEPS_DIR=$WFLOAT_SHERPA_DEPS_DIR"); fi
  if [ -n "${WFLOAT_ORT_HEADERS:-}" ]; then args+=("-DWFLOAT_ORT_HEADERS=$WFLOAT_ORT_HEADERS"); fi
  "$cmake_bin" -S "$android_dir/next-jni" -B "$build_dir" -G Ninja \
    "-DCMAKE_MAKE_PROGRAM=$ninja_bin" "-DCMAKE_TOOLCHAIN_FILE=$android_ndk/build/cmake/android.toolchain.cmake" \
    "-DANDROID_ABI=$abi" -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_shared \
    -DCMAKE_BUILD_TYPE=Release "${args[@]}"
  "$cmake_bin" --build "$build_dir" --target wfloat-next-jni --parallel "${WFLOAT_BUILD_JOBS:-6}"
  destination="$android_dir/src/main/jniLibs/$abi"
  mkdir -p "$destination"
  "$strip_bin" --strip-unneeded "$build_dir/libwfloat-next-jni.so" -o "$destination/libwfloat-next-jni.so"
  echo "Staged $destination/libwfloat-next-jni.so"
done

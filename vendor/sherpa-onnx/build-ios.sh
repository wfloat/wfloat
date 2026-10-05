#!/usr/bin/env bash
set -euo pipefail

dir=build-ios
mkdir -p "$dir"
cd "$dir"

# Keep this archive/layout pin in sync with WFLOAT_KITTEN_08.md.
onnxruntime_version=1.18.1
onnxruntime_sha256=52a82ca181186234a667a52e53f643bbb5845abe2ee47d3b1f0b0e69cf21da3d
onnxruntime_dir="ios-onnxruntime/$onnxruntime_version"
github_host=github.com

if [[ "${SHERPA_ONNX_GITHUB_MIRROW:-}" == "true" ]]; then
  github_host=hub.nuaa.cf
fi

mkdir -p "$onnxruntime_dir"
archive_name="onnxruntime.xcframework-${onnxruntime_version}.tar.bz2"
archive_path="$onnxruntime_dir/$archive_name"
archive_url="https://${github_host}/csukuangfj/onnxruntime-libs/releases/download/v${onnxruntime_version}/${archive_name}"
if [[ ! -f "$archive_path" ]]; then
  curl -L --fail --retry 3 -o "$archive_path.partial" "$archive_url"
  printf '%s  %s\n' "$onnxruntime_sha256" "$archive_path.partial" | shasum -a 256 -c -
  mv "$archive_path.partial" "$archive_path"
fi
# Verify cached downloads too; retain the archive for reproducible offline reuse.
printf '%s  %s\n' "$onnxruntime_sha256" "$archive_path" | shasum -a 256 -c -
checksum_marker="$onnxruntime_dir/.verified-archive-sha256"
if [[ ! -f "$onnxruntime_dir/onnxruntime.xcframework/ios-arm64/onnxruntime.a" ]] ||
   [[ ! -f "$checksum_marker" ]] ||
   [[ "$(cat "$checksum_marker")" != "$onnxruntime_sha256" ]]; then
  extract_dir="$(mktemp -d "$onnxruntime_dir/.extract.XXXXXX")"
  tar xjf "$archive_path" -C "$extract_dir"
  for library in ios-arm64 ios-arm64_x86_64-simulator; do
    test -f "$extract_dir/onnxruntime.xcframework/$library/onnxruntime.a"
  done
  test -f "$extract_dir/onnxruntime.xcframework/Headers/onnxruntime_c_api.h"
  if [[ -e "$onnxruntime_dir/onnxruntime.xcframework" ]]; then
    mv "$onnxruntime_dir/onnxruntime.xcframework" "$extract_dir/previous.xcframework"
  fi
  mv "$extract_dir/onnxruntime.xcframework" "$onnxruntime_dir/onnxruntime.xcframework"
  printf '%s\n' "$onnxruntime_sha256" > "$checksum_marker"
  # Keep any previous extraction available for recovery.
  rmdir "$extract_dir" 2>/dev/null || true
fi
# Always select the requested version, including when its cache was already hot.
ln -sfn "$onnxruntime_version/onnxruntime.xcframework" ios-onnxruntime/onnxruntime.xcframework

echo "Building for simulator (x86_64)"
export SHERPA_ONNXRUNTIME_LIB_DIR="$PWD/ios-onnxruntime/onnxruntime.xcframework/ios-arm64_x86_64-simulator"
export SHERPA_ONNXRUNTIME_INCLUDE_DIR="$PWD/ios-onnxruntime/onnxruntime.xcframework/Headers"
echo "SHERPA_ONNXRUNTIME_LIB_DIR: $SHERPA_ONNXRUNTIME_LIB_DIR"
echo "SHERPA_ONNXRUNTIME_INCLUDE_DIR: $SHERPA_ONNXRUNTIME_INCLUDE_DIR"

cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=SIMULATOR64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/simulator_x86_64
cmake --build build/simulator_x86_64 --parallel "${WFLOAT_BUILD_JOBS:-4}"

echo "Building for simulator (arm64)"
cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=SIMULATORARM64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/simulator_arm64
cmake --build build/simulator_arm64 --parallel "${WFLOAT_BUILD_JOBS:-4}"

echo "Building for arm64"
export SHERPA_ONNXRUNTIME_LIB_DIR="$PWD/ios-onnxruntime/onnxruntime.xcframework/ios-arm64"
cmake \
  -DBUILD_PIPER_PHONMIZE_EXE=OFF \
  -DBUILD_PIPER_PHONMIZE_TESTS=OFF \
  -DBUILD_ESPEAK_NG_EXE=OFF \
  -DBUILD_ESPEAK_NG_TESTS=OFF \
  -S .. \
  -DCMAKE_TOOLCHAIN_FILE=./toolchains/ios.toolchain.cmake \
  -DPLATFORM=OS64 \
  -DENABLE_BITCODE=0 \
  -DENABLE_ARC=1 \
  -DENABLE_VISIBILITY=0 \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DDEPLOYMENT_TARGET=13.0 \
  -B build/os64
cmake --build build/os64 --parallel "${WFLOAT_BUILD_JOBS:-4}"

# Install headers into one stable include root used by the xcframework output.
cmake --build build/os64 --target install

echo "Generate xcframework"
mkdir -p build/simulator/lib

for f in \
  libkaldi-native-fbank-core.a \
  libkissfft-float.a \
  libsherpa-onnx-c-api.a \
  libsherpa-onnx-core.a \
  libsherpa-onnx-fstfar.a \
  libssentencepiece_core.a \
  libsherpa-onnx-fst.a \
  libsherpa-onnx-kaldifst-core.a \
  libkaldi-decoder-core.a \
  libucd.a \
  libpiper_phonemize.a \
  libespeak-ng.a
do
  lipo -create \
    "build/simulator_arm64/lib/${f}" \
    "build/simulator_x86_64/lib/${f}" \
    -output "build/simulator/lib/${f}"
done

libtool -static -o build/simulator/libsherpa-onnx.a \
  build/simulator/lib/libkaldi-native-fbank-core.a \
  build/simulator/lib/libkissfft-float.a \
  build/simulator/lib/libsherpa-onnx-c-api.a \
  build/simulator/lib/libsherpa-onnx-core.a \
  build/simulator/lib/libsherpa-onnx-fstfar.a \
  build/simulator/lib/libsherpa-onnx-fst.a \
  build/simulator/lib/libsherpa-onnx-kaldifst-core.a \
  build/simulator/lib/libkaldi-decoder-core.a \
  build/simulator/lib/libucd.a \
  build/simulator/lib/libpiper_phonemize.a \
  build/simulator/lib/libespeak-ng.a \
  build/simulator/lib/libssentencepiece_core.a

libtool -static -o build/os64/libsherpa-onnx.a \
  build/os64/lib/libkaldi-native-fbank-core.a \
  build/os64/lib/libkissfft-float.a \
  build/os64/lib/libsherpa-onnx-c-api.a \
  build/os64/lib/libsherpa-onnx-core.a \
  build/os64/lib/libsherpa-onnx-fstfar.a \
  build/os64/lib/libsherpa-onnx-fst.a \
  build/os64/lib/libsherpa-onnx-kaldifst-core.a \
  build/os64/lib/libkaldi-decoder-core.a \
  build/os64/lib/libucd.a \
  build/os64/lib/libpiper_phonemize.a \
  build/os64/lib/libespeak-ng.a \
  build/os64/lib/libssentencepiece_core.a

rm -rf sherpa-onnx.xcframework
xcodebuild -create-xcframework \
  -library build/os64/libsherpa-onnx.a -headers install/include \
  -library build/simulator/libsherpa-onnx.a -headers install/include \
  -output sherpa-onnx.xcframework

#!/usr/bin/env bash
set -euo pipefail

# Build sherpa-onnx Android JNI libraries for packages/react-native-wfloat.
#
# This script intentionally does not copy artifacts into the React Native
# package. After it finishes, the built libraries are left in:
#
#   build-android-<abi>/install/lib/
#
# By default it builds React Native's common Android ABI set:
#
#   arm64-v8a armeabi-v7a x86_64 x86
#
# To build only a subset:
#
#   ./prepare-react-native-wfloat-android.sh arm64-v8a x86_64

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

build_dir_for_abi() {
  case "$1" in
    arm64-v8a)
      echo "build-android-arm64-v8a"
      ;;
    armeabi-v7a | armv7-eabi)
      echo "build-android-armv7-eabi"
      ;;
    x86_64 | x86-64)
      echo "build-android-x86-64"
      ;;
    x86)
      echo "build-android-x86"
      ;;
    *)
      return 1
      ;;
  esac
}

find_latest_ndk() {
  local sdk_dir

  for sdk_dir in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
    if [[ -n "$sdk_dir" && -d "$sdk_dir/ndk" ]]; then
      find "$sdk_dir/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1
      return 0
    fi
  done

  return 1
}

if [[ -z "${ANDROID_NDK:-}" ]]; then
  if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    export ANDROID_NDK="$ANDROID_NDK_HOME"
  else
    latest_ndk="$(find_latest_ndk || true)"
    if [[ -n "$latest_ndk" ]]; then
      export ANDROID_NDK="$latest_ndk"
    fi
  fi
fi

if [[ -z "${ANDROID_NDK:-}" || ! -d "$ANDROID_NDK" ]]; then
  cat >&2 <<'EOF'
ANDROID_NDK is not set, and no Android NDK was found automatically.

Install the NDK with Android Studio, then run this script like:

  export ANDROID_NDK="$HOME/Library/Android/sdk/ndk/<your-ndk-version>"
  ./prepare-react-native-wfloat-android.sh
EOF
  exit 1
fi

export SHERPA_ONNX_ENABLE_TTS="${SHERPA_ONNX_ENABLE_TTS:-ON}"
export SHERPA_ONNX_ENABLE_JNI="${SHERPA_ONNX_ENABLE_JNI:-ON}"
export SHERPA_ONNX_ENABLE_C_API="${SHERPA_ONNX_ENABLE_C_API:-ON}"
export SHERPA_ONNX_ENABLE_BINARY="${SHERPA_ONNX_ENABLE_BINARY:-OFF}"
export SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION="${SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION:-OFF}"

abis=("$@")
if [[ ${#abis[@]} -eq 0 ]]; then
  abis=(arm64-v8a armeabi-v7a x86_64 x86)
fi

echo "ANDROID_NDK=$ANDROID_NDK"
echo "SHERPA_ONNX_ENABLE_TTS=$SHERPA_ONNX_ENABLE_TTS"
echo "SHERPA_ONNX_ENABLE_JNI=$SHERPA_ONNX_ENABLE_JNI"
echo "SHERPA_ONNX_ENABLE_C_API=$SHERPA_ONNX_ENABLE_C_API"
echo "SHERPA_ONNX_ENABLE_BINARY=$SHERPA_ONNX_ENABLE_BINARY"
echo "SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=$SHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION"
echo "Building ABIs: ${abis[*]}"

for abi in "${abis[@]}"; do
  case "$abi" in
    arm64-v8a)
      ./build-android-arm64-v8a.sh
      ;;
    armeabi-v7a | armv7-eabi)
      ./build-android-armv7-eabi.sh
      ;;
    x86_64 | x86-64)
      ./build-android-x86-64.sh
      ;;
    x86)
      ./build-android-x86.sh
      ;;
    *)
      echo "Unsupported ABI: $abi" >&2
      echo "Supported ABIs: arm64-v8a armeabi-v7a x86_64 x86" >&2
      exit 1
      ;;
  esac
done

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required to package the built libraries." >&2
  exit 1
fi

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/sherpa-onnx-android-zip.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT

for abi in "${abis[@]}"; do
  build_dir="$(build_dir_for_abi "$abi")"
  so_files=("$build_dir"/install/lib/*.so)

  if [[ ${#so_files[@]} -eq 0 ]]; then
    echo "No .so files found in $build_dir/install/lib for ABI $abi" >&2
    exit 1
  fi

  mkdir -p "$staging_dir/$abi"
  cp "${so_files[@]}" "$staging_dir/$abi/"
done

zip_name="sherpa-onnx-android.zip"
rm -f "$zip_name"
(
  cd "$staging_dir"
  zip -r "$script_dir/$zip_name" ./*
)

echo
echo "Build complete. No files were copied into packages/react-native-wfloat."
echo
echo "Artifacts are in:"
for abi in "${abis[@]}"; do
  build_dir="$(build_dir_for_abi "$abi")"
  echo "  $build_dir/install/lib/"
done

echo
echo "Zip file created:"
echo "  $zip_name"

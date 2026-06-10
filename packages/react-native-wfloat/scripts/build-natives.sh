#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
SHERPA_DIR="${REPO_ROOT}/vendor/sherpa-onnx"
ANDROID_LLM_JNI_DIR="${PACKAGE_DIR}/android/llm-jni"
IOS_LLM_BUILD_SCRIPT="${SCRIPT_DIR}/build-ios-llm-xcframework.sh"
ANDROID_ABIS=()

normalize_android_abi() {
  case "$1" in
    arm64-v8a)
      echo "arm64-v8a"
      ;;
    armeabi-v7a | armv7-eabi)
      echo "armeabi-v7a"
      ;;
    x86_64 | x86-64)
      echo "x86_64"
      ;;
    x86)
      echo "x86"
      ;;
    *)
      return 1
      ;;
  esac
}

read_android_abis() {
  local raw abi normalized
  raw="${WFLOAT_ANDROID_ABIS:-}"

  if [[ -z "${raw}" ]]; then
    ANDROID_ABIS=(arm64-v8a armeabi-v7a x86_64 x86)
    return 0
  fi

  raw="${raw//,/ }"
  ANDROID_ABIS=()

  for abi in ${raw}; do
    normalized="$(normalize_android_abi "${abi}" || true)"

    if [[ -z "${normalized}" ]]; then
      echo "Unsupported Android ABI: ${abi}" >&2
      echo "Supported ABIs: arm64-v8a armeabi-v7a x86_64 x86" >&2
      exit 1
    fi

    ANDROID_ABIS+=("${normalized}")
  done

  if [[ ${#ANDROID_ABIS[@]} -eq 0 ]]; then
    echo "WFLOAT_ANDROID_ABIS did not contain any Android ABIs." >&2
    exit 1
  fi
}

android_sherpa_script_for_abi() {
  case "$1" in
    arm64-v8a)
      echo "build-android-arm64-v8a.sh"
      ;;
    armeabi-v7a)
      echo "build-android-armv7-eabi.sh"
      ;;
    x86_64)
      echo "build-android-x86-64.sh"
      ;;
    x86)
      echo "build-android-x86.sh"
      ;;
    *)
      return 1
      ;;
  esac
}

android_build_dir_for_abi() {
  case "$1" in
    arm64-v8a)
      echo "${REPO_ROOT}/out/rn-llm-android-arm64-v8a"
      ;;
    armeabi-v7a)
      echo "${REPO_ROOT}/out/rn-llm-android-armeabi-v7a"
      ;;
    x86_64)
      echo "${REPO_ROOT}/out/rn-llm-android-x86_64"
      ;;
    x86)
      echo "${REPO_ROOT}/out/rn-llm-android-x86"
      ;;
    *)
      return 1
      ;;
  esac
}

find_android_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "${ANDROID_NDK_HOME}" ]]; then
    echo "${ANDROID_NDK_HOME}"
    return 0
  fi

  if [[ -n "${ANDROID_NDK_ROOT:-}" && -d "${ANDROID_NDK_ROOT}" ]]; then
    echo "${ANDROID_NDK_ROOT}"
    return 0
  fi

  if [[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME}/ndk" ]]; then
    find "${ANDROID_HOME}/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1
    return 0
  fi

  return 1
}

build_android_llm_jni() {
  local ndk_dir="$1"
  shift
  local abi build_dir
  local abis=("$@")

  for abi in "${abis[@]}"; do
    build_dir="$(android_build_dir_for_abi "${abi}")"
    echo "Building Android LLM JNI bridge for ${abi}..."
    cmake \
      -S "${ANDROID_LLM_JNI_DIR}" \
      -B "${build_dir}" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_TOOLCHAIN_FILE="${ndk_dir}/build/cmake/android.toolchain.cmake" \
      -DANDROID_ABI="${abi}" \
      -DANDROID_PLATFORM=android-23
    cmake --build "${build_dir}" --config Release --parallel
  done
}

build_ios=false
build_android=false

if [[ $# -eq 0 ]]; then
  build_ios=true
  build_android=true
else
  for platform in "$@"; do
    case "${platform}" in
      ios)
        build_ios=true
        ;;
      android)
        build_android=true
        ;;
      all)
        build_ios=true
        build_android=true
        ;;
      *)
        echo "Unknown platform: ${platform}" >&2
        echo "Usage: yarn rn:build-natives [ios|android|all]" >&2
        exit 1
        ;;
    esac
  done
fi

if [[ ! -d "${SHERPA_DIR}" ]]; then
  echo "Missing sherpa-onnx vendor directory: ${SHERPA_DIR}" >&2
  exit 1
fi

if [[ "${build_ios}" == true ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "iOS native builds require macOS." >&2
    exit 1
  fi

  echo "Building iOS sherpa-onnx XCFrameworks..."
  (cd "${SHERPA_DIR}" && ./build-ios.sh)

  echo "Building iOS wfloat-core LLM XCFramework..."
  bash "${IOS_LLM_BUILD_SCRIPT}"
fi

if [[ "${build_android}" == true ]]; then
  read_android_abis
  echo "Android ABIs: ${ANDROID_ABIS[*]}"

  for abi in "${ANDROID_ABIS[@]}"; do
    required_script="$(android_sherpa_script_for_abi "${abi}")"
    if [[ ! -x "${SHERPA_DIR}/${required_script}" ]]; then
      cat >&2 <<EOF
Missing Android sherpa-onnx build helper: ${SHERPA_DIR}/${required_script}

The high-level Android build command delegates to:
  ${SHERPA_DIR}/prepare-react-native-wfloat-android.sh

That script expects the per-ABI sherpa-onnx Android build helpers to exist first.
EOF
      exit 1
    fi
  done

  echo "Building Android sherpa-onnx JNI libraries..."
  (cd "${SHERPA_DIR}" && ./prepare-react-native-wfloat-android.sh "${ANDROID_ABIS[@]}")

  ndk_dir="$(find_android_ndk || true)"
  if [[ -z "${ndk_dir}" ]]; then
    echo "Could not find Android NDK. Set ANDROID_NDK_HOME or ANDROID_HOME." >&2
    exit 1
  fi

  build_android_llm_jni "${ndk_dir}" "${ANDROID_ABIS[@]}"
fi

echo
echo "Native build step complete."
echo "Run yarn rn:stage-natives to copy artifacts into the React Native package."

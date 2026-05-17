#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
SHERPA_DIR="${REPO_ROOT}/vendor/sherpa-onnx"

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
fi

if [[ "${build_android}" == true ]]; then
  required_android_scripts=(
    build-android-arm64-v8a.sh
    build-android-armv7-eabi.sh
    build-android-x86-64.sh
    build-android-x86.sh
  )

  for required_script in "${required_android_scripts[@]}"; do
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
  (cd "${SHERPA_DIR}" && ./prepare-react-native-wfloat-android.sh)
fi

echo
echo "Native build step complete."
echo "Run yarn rn:stage-natives to copy artifacts into the React Native package."

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
SHERPA_DIR="${REPO_ROOT}/vendor/sherpa-onnx"

IOS_DIR="${PACKAGE_DIR}/ios"
JNI_LIBS_DIR="${PACKAGE_DIR}/android/src/main/jniLibs"

stage_ios=false
stage_android=false

if [[ $# -eq 0 ]]; then
  stage_ios=true
  stage_android=true
else
  for platform in "$@"; do
    case "${platform}" in
      ios)
        stage_ios=true
        ;;
      android)
        stage_android=true
        ;;
      all)
        stage_ios=true
        stage_android=true
        ;;
      *)
        echo "Unknown platform: ${platform}" >&2
        echo "Usage: yarn rn:stage-natives [ios|android|all]" >&2
        exit 1
        ;;
    esac
  done
fi

require_dir() {
  local dir="$1"
  local hint="$2"

  if [[ ! -d "${dir}" ]]; then
    echo "Missing ${hint}: ${dir}" >&2
    echo "Run yarn rn:build-natives first." >&2
    exit 1
  fi
}

copy_real_dir() {
  local source_dir="$1"
  local destination_dir="$2"

  rm -rf "${destination_dir}"
  mkdir -p "$(dirname "${destination_dir}")"

  # -L dereferences local development symlinks so npm receives real files.
  cp -R -L "${source_dir}" "${destination_dir}"

  if [[ -L "${destination_dir}" ]]; then
    echo "Staged artifact is still a symlink: ${destination_dir}" >&2
    exit 1
  fi
}

android_build_dir_for_abi() {
  case "$1" in
    arm64-v8a)
      echo "${SHERPA_DIR}/build-android-arm64-v8a"
      ;;
    armeabi-v7a)
      echo "${SHERPA_DIR}/build-android-armv7-eabi"
      ;;
    x86_64)
      echo "${SHERPA_DIR}/build-android-x86-64"
      ;;
    x86)
      echo "${SHERPA_DIR}/build-android-x86"
      ;;
    *)
      return 1
      ;;
  esac
}

stage_android_from_build_dirs() {
  local staged_any=false
  local abi build_dir source_dir destination_dir
  local abis=(arm64-v8a armeabi-v7a x86_64 x86)

  for abi in "${abis[@]}"; do
    build_dir="$(android_build_dir_for_abi "${abi}")"
    source_dir="${build_dir}/install/lib"

    if ! find "${source_dir}" -maxdepth 1 -type f -name '*.so' 2>/dev/null | grep -q .; then
      return 1
    fi

    destination_dir="${JNI_LIBS_DIR}/${abi}"
    mkdir -p "${destination_dir}"
    find "${destination_dir}" -maxdepth 1 -type f -name '*.so' -delete
    find "${source_dir}" -maxdepth 1 -type f -name '*.so' -exec cp {} "${destination_dir}/" \;
    staged_any=true
  done

  [[ "${staged_any}" == true ]]
}

stage_android_from_zip() {
  local archive_path="${SHERPA_DIR}/sherpa-onnx-android.zip"
  local temp_dir abi source_dir destination_dir
  local abis=(arm64-v8a armeabi-v7a x86_64 x86)

  if [[ ! -f "${archive_path}" ]]; then
    return 1
  fi

  if ! command -v unzip >/dev/null 2>&1; then
    echo "unzip is required to stage Android natives from ${archive_path}" >&2
    exit 1
  fi

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/wfloat-android-natives.XXXXXX")"
  unzip -oq "${archive_path}" -d "${temp_dir}"

  for abi in "${abis[@]}"; do
    source_dir="${temp_dir}/${abi}"

    if ! find "${source_dir}" -maxdepth 1 -type f -name '*.so' 2>/dev/null | grep -q .; then
      echo "Missing Android ABI ${abi} in ${archive_path}" >&2
      rm -rf "${temp_dir}"
      exit 1
    fi

    destination_dir="${JNI_LIBS_DIR}/${abi}"
    mkdir -p "${destination_dir}"
    find "${destination_dir}" -maxdepth 1 -type f -name '*.so' -delete
    find "${source_dir}" -maxdepth 1 -type f -name '*.so' -exec cp {} "${destination_dir}/" \;
  done

  rm -rf "${temp_dir}"
}

if [[ "${stage_ios}" == true ]]; then
  sherpa_xcframework="${SHERPA_DIR}/build-ios/sherpa-onnx.xcframework"
  onnxruntime_xcframework="${SHERPA_DIR}/build-ios/ios-onnxruntime/onnxruntime.xcframework"

  require_dir "${sherpa_xcframework}" "sherpa-onnx.xcframework"
  require_dir "${onnxruntime_xcframework}" "onnxruntime.xcframework"

  echo "Staging iOS XCFrameworks..."
  copy_real_dir "${sherpa_xcframework}" "${IOS_DIR}/sherpa-onnx.xcframework"
  copy_real_dir "${onnxruntime_xcframework}" "${IOS_DIR}/onnxruntime.xcframework"
fi

if [[ "${stage_android}" == true ]]; then
  echo "Staging Android JNI libraries..."
  mkdir -p "${JNI_LIBS_DIR}"

  if ! stage_android_from_build_dirs; then
    if ! stage_android_from_zip; then
      cat >&2 <<EOF
Missing Android native outputs.

Expected either:
  ${SHERPA_DIR}/build-android-*/install/lib/*.so

or:
  ${SHERPA_DIR}/sherpa-onnx-android.zip

Run yarn rn:build-natives first.
EOF
      exit 1
    fi
  fi
fi

echo
echo "Native artifacts staged into ${PACKAGE_DIR}"

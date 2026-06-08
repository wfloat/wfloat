#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
SHERPA_DIR="${REPO_ROOT}/vendor/sherpa-onnx"
IOS_LLM_XCFRAMEWORK="${REPO_ROOT}/out/rn-llm-ios/wfloat-core-llm.xcframework"

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

trim_onnxruntime_ios_xcframework() {
  local xcframework_dir="$1"
  local info_plist="${xcframework_dir}/Info.plist"

  if [[ -d "${xcframework_dir}/macos-arm64_x86_64" ]]; then
    rm -rf "${xcframework_dir}/macos-arm64_x86_64"
  fi

  local library_dir

  while IFS= read -r library_dir; do
    if [[ -f "${library_dir}/onnxruntime.a" ]]; then
      rm -f "${library_dir}/libonnxruntime.a"
      mv "${library_dir}/onnxruntime.a" "${library_dir}/libonnxruntime.a"
    fi
  done < <(find "${xcframework_dir}" -mindepth 1 -maxdepth 1 -type d -name "ios-*")

  # The upstream onnxruntime archive includes a macOS slice, but this package
  # only vends iOS artifacts. Keep the XCFramework manifest aligned with the
  # files we publish so Xcode does not see a dangling library entry.
  if [[ -f "${info_plist}" ]] && command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    while /usr/libexec/PlistBuddy -c "Print :AvailableLibraries:0:SupportedPlatform" "${info_plist}" >/dev/null 2>&1; do
      local library_count
      library_count="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries" "${info_plist}" | grep -c "Dict {")"

      if [[ "${library_count}" -le 0 ]]; then
        break
      fi

      local removed=false
      local index=$((library_count - 1))

      while [[ "${index}" -ge 0 ]]; do
        local platform
        platform="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:${index}:SupportedPlatform" "${info_plist}" 2>/dev/null || true)"

        if [[ "${platform}" == "macos" ]]; then
          /usr/libexec/PlistBuddy -c "Delete :AvailableLibraries:${index}" "${info_plist}"
          removed=true
        else
          local library_path
          library_path="$(/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:${index}:LibraryPath" "${info_plist}" 2>/dev/null || true)"

          if [[ "${library_path}" == "onnxruntime.a" ]]; then
            /usr/libexec/PlistBuddy -c "Set :AvailableLibraries:${index}:LibraryPath libonnxruntime.a" "${info_plist}"
          fi
        fi

        index=$((index - 1))
      done

      if [[ "${removed}" != true ]]; then
        break
      fi
    done
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

android_llm_build_dir_for_abi() {
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

stage_android_llm_from_build_dirs() {
  local abi build_dir source_lib destination_dir
  local abis=(arm64-v8a armeabi-v7a x86_64 x86)

  for abi in "${abis[@]}"; do
    build_dir="$(android_llm_build_dir_for_abi "${abi}")"
    source_lib="${build_dir}/libwfloat-llm-jni.so"

    if [[ ! -f "${source_lib}" ]]; then
      cat >&2 <<EOF
Missing Android LLM JNI library for ${abi}: ${source_lib}

Run yarn rn:build-natives android first.
EOF
      exit 1
    fi

    destination_dir="${JNI_LIBS_DIR}/${abi}"
    mkdir -p "${destination_dir}"
    cp "${source_lib}" "${destination_dir}/"
  done
}

if [[ "${stage_ios}" == true ]]; then
  sherpa_xcframework="${SHERPA_DIR}/build-ios/sherpa-onnx.xcframework"
  onnxruntime_xcframework="${SHERPA_DIR}/build-ios/ios-onnxruntime/onnxruntime.xcframework"

  require_dir "${sherpa_xcframework}" "sherpa-onnx.xcframework"
  require_dir "${onnxruntime_xcframework}" "onnxruntime.xcframework"
  require_dir "${IOS_LLM_XCFRAMEWORK}" "wfloat-core-llm.xcframework"

  echo "Staging iOS XCFrameworks..."
  copy_real_dir "${sherpa_xcframework}" "${IOS_DIR}/sherpa-onnx.xcframework"
  copy_real_dir "${onnxruntime_xcframework}" "${IOS_DIR}/onnxruntime.xcframework"
  copy_real_dir "${IOS_LLM_XCFRAMEWORK}" "${IOS_DIR}/wfloat-core-llm.xcframework"
  trim_onnxruntime_ios_xcframework "${IOS_DIR}/onnxruntime.xcframework"
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

  stage_android_llm_from_build_dirs
fi

echo
echo "Native artifacts staged into ${PACKAGE_DIR}"

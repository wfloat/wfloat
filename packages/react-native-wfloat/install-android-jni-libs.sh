#!/usr/bin/env bash

# Maintainer-only helper for refreshing the Android JNI libs bundled in the
# published @wfloat/react-native-wfloat package. App developers consuming the
# package should not need to run this.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JNI_LIBS_DIR="${SCRIPT_DIR}/android/src/main/jniLibs"
VERSION="${1:-1.13.1}"
ARCHIVE_NAME="sherpa-onnx-android-${VERSION}.zip"
ARCHIVE_URL="https://registry.wfloat.com/sherpa-onnx-android/${ARCHIVE_NAME}"

ABIS=(
  "arm64-v8a"
  "armeabi-v7a"
  "x86"
  "x86_64"
)

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
}

require_command curl
require_command unzip
require_command find

mkdir -p "${JNI_LIBS_DIR}"

TEMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TEMP_DIR}/${ARCHIVE_NAME}"
EXTRACTED_DIR="${TEMP_DIR}/unzipped"

cleanup() {
  rm -rf "${TEMP_DIR}"
}

trap cleanup EXIT

echo "Downloading Android JNI libraries (${VERSION})..."
curl --fail --location --silent --show-error "${ARCHIVE_URL}" --output "${ARCHIVE_PATH}"

echo "Extracting ${ARCHIVE_NAME}..."
unzip -oq "${ARCHIVE_PATH}" -d "${EXTRACTED_DIR}"

for abi in "${ABIS[@]}"; do
  destination_dir="${JNI_LIBS_DIR}/${abi}"
  source_dir="${EXTRACTED_DIR}/${abi}"

  mkdir -p "${destination_dir}"

  if [ ! -d "${source_dir}" ]; then
    echo "Missing ABI directory in archive: ${abi}" >&2
    exit 1
  fi

  if ! find "${source_dir}" -maxdepth 1 -type f -name '*.so' | grep -q .; then
    echo "No .so files found for ABI: ${abi}" >&2
    exit 1
  fi

  echo "Installing ${abi}..."
  find "${destination_dir}" -maxdepth 1 -type f -name '*.so' -delete
  find "${source_dir}" -maxdepth 1 -type f -name '*.so' -exec cp {} "${destination_dir}/" \;
done

echo
echo "Installed Android JNI libraries into ${JNI_LIBS_DIR}"

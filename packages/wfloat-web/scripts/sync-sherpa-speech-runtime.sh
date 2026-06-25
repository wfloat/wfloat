#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
VENDOR_SHERPA_DIR="${REPO_ROOT}/vendor/sherpa-onnx"
DEFAULT_BUILD_DIR="${VENDOR_SHERPA_DIR}/build-wasm-simd-speech/install/bin/wasm/speech"
SOURCE_DIR="${1:-${DEFAULT_BUILD_DIR}}"
DEST_DIR="${PACKAGE_DIR}/src/wasm"

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Speech runtime build output not found: ${SOURCE_DIR}" >&2
  echo "Build it first with vendor/sherpa-onnx/build-wasm-simd-speech.sh" >&2
  exit 1
fi

for file in \
  sherpa-onnx-wasm-main-speech.js \
  sherpa-onnx-wasm-main-speech.wasm
do
  if [[ ! -f "${SOURCE_DIR}/${file}" ]]; then
    echo "Missing expected runtime file: ${SOURCE_DIR}/${file}" >&2
    exit 1
  fi
done

cp "${SOURCE_DIR}/sherpa-onnx-wasm-main-speech.js" "${DEST_DIR}/"
cp "${SOURCE_DIR}/sherpa-onnx-wasm-main-speech.wasm" "${DEST_DIR}/"

echo "Synced generated sherpa speech module JS into ${DEST_DIR}"
echo "Synced generated sherpa speech WASM into ${DEST_DIR}"

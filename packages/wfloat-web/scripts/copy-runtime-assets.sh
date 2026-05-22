#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_WASM_DIR="${PACKAGE_DIR}/src/wasm"
DIST_WASM_DIR="${PACKAGE_DIR}/dist/wasm"

mkdir -p "${DIST_WASM_DIR}"

cp "${SRC_WASM_DIR}/sherpa-onnx-wasm-main-speech.js" "${DIST_WASM_DIR}/"

for file in \
  wfloat-llama-wasm.js
do
  if [[ -f "${SRC_WASM_DIR}/${file}" ]]; then
    cp "${SRC_WASM_DIR}/${file}" "${DIST_WASM_DIR}/"
  fi
done

echo "Copied sherpa speech module JS into dist/wasm"

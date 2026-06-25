#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_WASM_DIR="${PACKAGE_DIR}/src/wasm"
DIST_WASM_DIR="${PACKAGE_DIR}/dist/wasm"
include_wasm=false

if [[ "${1:-}" == "--include-wasm" ]]; then
  include_wasm=true
elif [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: scripts/copy-runtime-assets.sh [--include-wasm]" >&2
  exit 1
fi

mkdir -p "${DIST_WASM_DIR}"

for file in \
  sherpa-onnx-wasm-main-speech.js \
  wfloat-llama-wasm.js
do
  if [[ ! -f "${SRC_WASM_DIR}/${file}" ]]; then
    echo "Missing expected runtime asset: ${SRC_WASM_DIR}/${file}" >&2
    echo "Generate runtime assets with npm run build:wasm." >&2
    exit 1
  fi
  cp "${SRC_WASM_DIR}/${file}" "${DIST_WASM_DIR}/"
done

if [[ "${include_wasm}" == true ]]; then
  for file in \
    sherpa-onnx-wasm-main-speech.wasm \
    wfloat-llama-wasm.wasm
  do
    if [[ ! -f "${SRC_WASM_DIR}/${file}" ]]; then
      echo "Missing expected runtime asset: ${SRC_WASM_DIR}/${file}" >&2
      echo "Generate runtime assets with npm run build:wasm." >&2
      exit 1
    fi
    cp "${SRC_WASM_DIR}/${file}" "${DIST_WASM_DIR}/"
  done
fi

echo "Copied runtime assets into dist/wasm"

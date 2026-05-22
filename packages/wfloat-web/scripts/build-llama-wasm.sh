#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"
NATIVE_DIR="${PACKAGE_DIR}/native/llama-wasm"
VENDOR_LLAMA_DIR="${REPO_ROOT}/vendor/llama.cpp"
BUILD_DIR="${VENDOR_LLAMA_DIR}/build-wasm-wfloat"
DEST_DIR="${PACKAGE_DIR}/src/wasm"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake not found. Activate/install Emscripten before building llama.cpp WASM." >&2
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake not found." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

emcmake cmake \
  -S "${NATIVE_DIR}" \
  -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_CPP_DIR="${VENDOR_LLAMA_DIR}"

cmake --build "${BUILD_DIR}" --target wfloat-llama-wasm -j "${WFLOAT_BUILD_JOBS:-8}"

for file in wfloat-llama-wasm.js wfloat-llama-wasm.wasm; do
  if [[ ! -f "${BUILD_DIR}/${file}" ]]; then
    echo "Missing expected llama WASM artifact: ${BUILD_DIR}/${file}" >&2
    exit 1
  fi
  cp "${BUILD_DIR}/${file}" "${DEST_DIR}/${file}"
done

echo "Built llama.cpp WASM runtime into ${DEST_DIR}"
echo "Publish/stage wfloat-llama-wasm.wasm through the model asset runtime manifest before using it remotely."

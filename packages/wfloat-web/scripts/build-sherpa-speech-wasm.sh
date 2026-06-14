#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PACKAGE_DIR}/../.." && pwd)"

# shellcheck disable=SC1091
source "${REPO_ROOT}/scripts/ensure-emscripten.sh"

pushd "${REPO_ROOT}/vendor/sherpa-onnx" >/dev/null
bash ./build-wasm-simd-speech.sh
popd >/dev/null

bash "${SCRIPT_DIR}/sync-sherpa-speech-runtime.sh"

#!/usr/bin/env bash

set -euo pipefail

WFLOAT_EMSCRIPTEN_VERSION="${WFLOAT_EMSCRIPTEN_VERSION:-3.1.53}"
WFLOAT_EMSDK_REPO="${WFLOAT_EMSDK_REPO:-https://github.com/emscripten-core/emsdk.git}"
WFLOAT_EMSDK_DIR="${WFLOAT_EMSDK_DIR:-${HOME}/.cache/wfloat/emsdk}"

emscripten_version_matches() {
  command -v emcc >/dev/null 2>&1 &&
    emcc --version 2>/dev/null | head -n 1 | grep -q "${WFLOAT_EMSCRIPTEN_VERSION}"
}

if [[ -f "${WFLOAT_EMSDK_DIR}/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${WFLOAT_EMSDK_DIR}/emsdk_env.sh" >/dev/null
fi

if ! emscripten_version_matches; then
  if [[ ! -d "${WFLOAT_EMSDK_DIR}/.git" ]]; then
    mkdir -p "$(dirname "${WFLOAT_EMSDK_DIR}")"
    git clone --depth 1 "${WFLOAT_EMSDK_REPO}" "${WFLOAT_EMSDK_DIR}"
  fi

  "${WFLOAT_EMSDK_DIR}/emsdk" install "${WFLOAT_EMSCRIPTEN_VERSION}"
  "${WFLOAT_EMSDK_DIR}/emsdk" activate --embedded "${WFLOAT_EMSCRIPTEN_VERSION}"

  # shellcheck disable=SC1091
  source "${WFLOAT_EMSDK_DIR}/emsdk_env.sh" >/dev/null
fi

if ! emscripten_version_matches; then
  echo "Failed to activate Emscripten ${WFLOAT_EMSCRIPTEN_VERSION} from ${WFLOAT_EMSDK_DIR}" >&2
  exit 1
fi

if ! command -v emcmake >/dev/null 2>&1; then
  echo "Activated Emscripten, but emcmake was not found on PATH." >&2
  exit 1
fi

echo "Using $(emcc --version | head -n 1)"

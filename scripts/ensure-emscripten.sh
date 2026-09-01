#!/usr/bin/env bash

set -euo pipefail

WFLOAT_EMSCRIPTEN_VERSION="${WFLOAT_EMSCRIPTEN_VERSION:-4.0.8}"
WFLOAT_EMSDK_REPO="${WFLOAT_EMSDK_REPO:-https://github.com/emscripten-core/emsdk.git}"
WFLOAT_EMSDK_REVISION="${WFLOAT_EMSDK_REVISION:-419021fa040428bc69ef1559b325addb8e10211f}"
WFLOAT_EMSDK_DIR="${WFLOAT_EMSDK_DIR:-${HOME}/.cache/wfloat/emsdk}"

normalize_git_url() {
  local value="${1%/}"
  printf '%s\n' "${value%.git}"
}

ensure_emsdk_checkout() {
  if [[ ! "${WFLOAT_EMSCRIPTEN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "WFLOAT_EMSCRIPTEN_VERSION must be an exact semantic version." >&2
    return 1
  fi
  if [[ ! "${WFLOAT_EMSDK_REVISION}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "WFLOAT_EMSDK_REVISION must be a full lowercase Git commit." >&2
    return 1
  fi

  if [[ -e "${WFLOAT_EMSDK_DIR}" && ! -d "${WFLOAT_EMSDK_DIR}/.git" ]]; then
    echo "Refusing non-Git Emscripten SDK cache: ${WFLOAT_EMSDK_DIR}" >&2
    return 1
  fi

  if [[ ! -d "${WFLOAT_EMSDK_DIR}/.git" ]]; then
    mkdir -p "$(dirname "${WFLOAT_EMSDK_DIR}")"
    git clone --filter=blob:none --no-checkout "${WFLOAT_EMSDK_REPO}" "${WFLOAT_EMSDK_DIR}"
  else
    local actual_origin
    actual_origin="$(git -C "${WFLOAT_EMSDK_DIR}" remote get-url origin)"
    if [[ "$(normalize_git_url "${actual_origin}")" != "$(normalize_git_url "${WFLOAT_EMSDK_REPO}")" ]]; then
      echo "Emscripten SDK cache origin mismatch: ${actual_origin}" >&2
      return 1
    fi
    local status
    status="$(git -C "${WFLOAT_EMSDK_DIR}" status --porcelain --untracked-files=normal)"
    if [[ -n "${status}" ]]; then
      echo "Refusing modified Emscripten SDK cache: ${WFLOAT_EMSDK_DIR}" >&2
      return 1
    fi
  fi

  if ! git -C "${WFLOAT_EMSDK_DIR}" cat-file -e "${WFLOAT_EMSDK_REVISION}^{commit}" 2>/dev/null; then
    git -C "${WFLOAT_EMSDK_DIR}" fetch --depth 1 origin "${WFLOAT_EMSDK_REVISION}"
  fi
  git -C "${WFLOAT_EMSDK_DIR}" checkout --quiet --detach "${WFLOAT_EMSDK_REVISION}"

  local actual_revision
  actual_revision="$(git -C "${WFLOAT_EMSDK_DIR}" rev-parse HEAD^{commit})"
  if [[ "${actual_revision}" != "${WFLOAT_EMSDK_REVISION}" ]]; then
    echo "Emscripten SDK checkout mismatch: ${actual_revision}" >&2
    return 1
  fi
}

emscripten_reported_version() {
  local version_line
  version_line="$(emcc --version 2>/dev/null | head -n 1)" || return 1
  if [[ "${version_line}" =~ \)\ ([0-9]+\.[0-9]+\.[0-9]+)([[:space:]]|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

emscripten_version_matches() {
  local reported
  command -v emcc >/dev/null 2>&1 || return 1
  reported="$(emscripten_reported_version)" || return 1
  [[ "${reported}" == "${WFLOAT_EMSCRIPTEN_VERSION}" ]]
}

ensure_emsdk_checkout

if [[ -f "${WFLOAT_EMSDK_DIR}/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${WFLOAT_EMSDK_DIR}/emsdk_env.sh" >/dev/null
fi

if ! emscripten_version_matches; then
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

echo "Using Emscripten $(emscripten_reported_version) from emsdk ${WFLOAT_EMSDK_REVISION}"

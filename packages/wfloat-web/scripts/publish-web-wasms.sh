#!/usr/bin/env bash
set -euo pipefail

: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token is unavailable}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC request URL is unavailable}"
: "${GITHUB_ENV:?GitHub environment file is unavailable}"

api_url="${WFLOAT_WEB_WASM_API:-https://wfloat.com/api/web-wasms}"
audience=$(jq -rn --arg value "${api_url}" '$value | @uri')
token=$(curl --fail --silent --show-error \
  -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}" | jq -er '.value')

response=$(curl --fail --silent --show-error \
  -H "Authorization: Bearer ${token}" \
  -H "Accept: application/json" \
  -F "sherpa=@src/wasm/sherpa-onnx-wasm-main-speech.wasm;type=application/wasm" \
  -F "llama=@src/wasm/wfloat-llama-wasm.wasm;type=application/wasm" \
  "${api_url}")

sherpa_url=$(jq -er '.sherpa.url' <<< "${response}")
llama_url=$(jq -er '.llama.url' <<< "${response}")
sherpa_sha256=$(jq -er '.sherpa.sha256' <<< "${response}")
llama_sha256=$(jq -er '.llama.sha256' <<< "${response}")

verify_public_asset() {
  local url=$1
  local expected_sha256=$2
  local output
  local headers
  output=$(mktemp)
  headers=$(mktemp)

  curl --fail --silent --show-error --retry 5 --retry-all-errors \
    -H "Origin: https://consumer.example" \
    -D "${headers}" \
    -o "${output}" \
    "${url}"

  echo "${expected_sha256}  ${output}" | sha256sum --check --status
  tr -d '\r' < "${headers}" |
    grep -Eiq '^access-control-allow-origin: (\*|https://consumer\.example)$'
  rm -f "${output}" "${headers}"
}

verify_public_asset "${sherpa_url}" "${sherpa_sha256}"
verify_public_asset "${llama_url}" "${llama_sha256}"

{
  echo "WFLOAT_WEB_SHERPA_WASM_URL=${sherpa_url}"
  echo "WFLOAT_WEB_LLAMA_WASM_URL=${llama_url}"
} >> "${GITHUB_ENV}"

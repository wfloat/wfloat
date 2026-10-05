#!/usr/bin/env bash
# Compatibility entrypoint: legacy and new APIs must use the same llama build.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/build-ios-next-xcframework.sh" "$@"

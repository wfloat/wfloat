#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the Android NDK directory}"
out="${1:?Pass an output directory for test-only JNI libraries}"
source_root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out/arm64-v8a"
"$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android24-clang++" \
  -std=c++17 -O2 -Wall -Wextra -Werror -fPIC -shared \
  "$source_root/android/app/src/androidTest/cpp/ThreadSchedulerProbe.cpp" \
  -o "$out/arm64-v8a/libbench_scheduler_probe.so"

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


BUILDER_PREFIX = "tools/onnxruntime-build/"
RECIPE_PREFIX = BUILDER_PREFIX + "onnxruntime_builder/recipes/"

# Exact artifacts that Wfloat exercises automatically. Verification remains a
# catalog property: an unverified target can run here to gather the evidence
# needed to promote it later.
AUTOMATIC_BUILDS = {
    "android": {"recipe": "android", "target": "android"},
    "ios-static-xcframework": {
        "recipe": "apple_xcframework",
        "target": "ios-static-xcframework",
    },
    "wasm-static_lib-simd": {
        "recipe": "wasm",
        "target": "wasm-static_lib-simd",
    },
    "linux-x64-glibc2_17": {
        "recipe": "linux_native",
        "target": "linux-x64-glibc2_17",
    },
    "linux-aarch64-glibc2_17": {
        "recipe": "linux_native",
        "target": "linux-aarch64-glibc2_17",
    },
    "osx-arm64-static_lib": {
        "recipe": "macos_static",
        "target": "osx-arm64-static_lib",
    },
    "osx-x86_64-static_lib": {
        "recipe": "macos_static",
        "target": "osx-x86_64-static_lib",
    },
    "win-x64-static_lib-mt": {
        "recipe": "windows_cpu",
        "target": "win-x64-static_lib-mt",
    },
}

NON_BUILD_FILES = {
    BUILDER_PREFIX + "onnxruntime_builder/validate.py",
    BUILDER_PREFIX + "README.md",
    BUILDER_PREFIX + "PROVENANCE.md",
    ".github/workflows/onnxruntime-builder-manual.yml",
}
WASM_CONSUMER_FILES = {
    "vendor/sherpa-onnx/build-wasm-simd-speech.sh",
    "vendor/sherpa-onnx/cmake/onnxruntime-wasm-simd.cmake",
    "vendor/sherpa-onnx/wasm/speech/CMakeLists.txt",
    "vendor/sherpa-onnx/wasm/wasm-common.cmake",
    "scripts/ensure-emscripten.sh",
    "packages/wfloat-web/scripts/build-sherpa-speech-wasm.sh",
}


def _changed_paths(base: str, head: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...{head}"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    return [line for line in result.stdout.splitlines() if line]


def _builds_for_recipe(recipe: str) -> set[str]:
    return {
        build_id
        for build_id, definition in AUTOMATIC_BUILDS.items()
        if definition["recipe"] == recipe
    }


def select_builds(paths: list[str], *, select_all: bool = False) -> list[str]:
    selected = set(AUTOMATIC_BUILDS) if select_all else set()
    for path in paths:
        if path in WASM_CONSUMER_FILES:
            selected.add("wasm-static_lib-simd")
            continue
        if path == ".github/workflows/onnxruntime-builder-ci.yml":
            selected.update(AUTOMATIC_BUILDS)
            continue
        if path.startswith(RECIPE_PREFIX):
            module = Path(path).stem
            if module == "__init__":
                selected.update(AUTOMATIC_BUILDS)
            else:
                selected.update(_builds_for_recipe(module))
            continue
        if path in NON_BUILD_FILES:
            continue
        if path == BUILDER_PREFIX + "ort-builder":
            selected.update(AUTOMATIC_BUILDS)
            continue
        if path.startswith(BUILDER_PREFIX + "ci/"):
            selected.update(AUTOMATIC_BUILDS)
            continue
        if path.startswith(BUILDER_PREFIX + "docs/") or path.startswith(
            BUILDER_PREFIX + "tests/"
        ):
            continue
        if path.startswith(BUILDER_PREFIX + "onnxruntime_builder/") or path == (
            BUILDER_PREFIX + "source-lock.json"
        ):
            selected.update(AUTOMATIC_BUILDS)
    return [build_id for build_id in AUTOMATIC_BUILDS if build_id in selected]


def matrix_for(builds: list[str]) -> dict:
    return {"include": [AUTOMATIC_BUILDS[build_id] for build_id in builds]}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Select automatic ONNX Runtime artifact builds from changed files"
    )
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--all", action="store_true", help="Select every automatic build")
    parser.add_argument("--path", action="append", default=[], help="Changed path; repeat for tests")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()

    if args.all:
        paths: list[str] = []
    elif args.path:
        paths = args.path
    elif args.base:
        paths = _changed_paths(args.base, args.head)
    else:
        parser.error("provide --all, at least one --path, or --base")

    builds = select_builds(paths, select_all=args.all)
    matrix = matrix_for(builds)
    compact = json.dumps(matrix, separators=(",", ":"))
    print(json.dumps({"paths": paths, "builds": builds, "matrix": matrix}, indent=2))
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"matrix={compact}\n")
            output.write(f"has_jobs={'true' if builds else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

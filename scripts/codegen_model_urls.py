#!/usr/bin/env python3

from __future__ import annotations

import argparse
import difflib
import json
import pprint
import sys
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT_DIR / "assets" / "registry.json"

PYTHON_OUTPUT = (
    ROOT_DIR
    / "packages"
    / "wfloat-python"
    / "python"
    / "wfloat"
    / "_generated_model_urls.py"
)
WEB_OUTPUT = (
    ROOT_DIR / "packages" / "wfloat-web" / "src" / "worker" / "generatedModelUrls.ts"
)
RN_OUTPUT = ROOT_DIR / "packages" / "react-native-wfloat" / "src" / "generatedModelUrls.ts"


def load_manifest() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf8"))
    expected_keys = {"origin", "models", "assets"}
    actual_keys = set(manifest)
    if actual_keys != expected_keys:
        raise SystemExit(
            "registry.json must contain exactly these top-level keys: "
            + ", ".join(sorted(expected_keys))
        )
    return manifest


def stable_json(value: Any, *, indent: int) -> str:
    return json.dumps(value, indent=indent, sort_keys=True)


def stable_python(value: Any) -> str:
    return pprint.pformat(value, width=88, sort_dicts=True)


def render_python(manifest: dict[str, Any]) -> str:
    return (
        "# Generated from wfloat/assets/registry.json. Do not edit.\n\n"
        f"REGISTRY_ORIGIN = {manifest['origin']!r}\n\n"
        f"MODEL_ASSETS = {stable_python(manifest['models'])}\n\n"
        f"SHARED_ASSETS = {stable_python(manifest['assets'])}\n"
    )


def render_typescript(manifest: dict[str, Any]) -> str:
    return (
        "// Generated from wfloat/assets/registry.json. Do not edit.\n\n"
        f"export const REGISTRY_ORIGIN = {json.dumps(manifest['origin'])};\n\n"
        f"export const MODEL_ASSETS = {stable_json(manifest['models'], indent=2)} as const;\n\n"
        f"export const SHARED_ASSETS = {stable_json(manifest['assets'], indent=2)} as const;\n"
    )


def expected_outputs(manifest: dict[str, Any]) -> dict[Path, str]:
    ts_output = render_typescript(manifest)
    return {
        PYTHON_OUTPUT: render_python(manifest),
        WEB_OUTPUT: ts_output,
        RN_OUTPUT: ts_output,
    }


def print_diff(path: Path, actual: str, expected: str) -> None:
    diff = difflib.unified_diff(
        actual.splitlines(keepends=True),
        expected.splitlines(keepends=True),
        fromfile=str(path),
        tofile=f"{path} (expected)",
    )
    sys.stderr.writelines(diff)


def check_outputs(outputs: dict[Path, str]) -> int:
    status = 0
    for path, expected in outputs.items():
        actual = path.read_text(encoding="utf8") if path.exists() else ""
        if actual != expected:
            print(f"Generated file is stale: {path}", file=sys.stderr)
            print_diff(path, actual, expected)
            status = 1
    return status


def write_outputs(outputs: dict[Path, str]) -> None:
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if generated files are not up to date",
    )
    args = parser.parse_args()

    outputs = expected_outputs(load_manifest())
    if args.check:
        return check_outputs(outputs)

    write_outputs(outputs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

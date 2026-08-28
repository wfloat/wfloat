#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path


BUILDER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = BUILDER_ROOT.parents[1]
MANYLINUX_IMAGES = {
    # Pin manifests so an identical builder commit cannot silently acquire a
    # different compiler or sysroot through the moving default image tag.
    "linux-x64-glibc2_17": (
        "quay.io/pypa/manylinux2014_x86_64@"
        "sha256:edb6edbd84c2fa9d40ee83abb160e302ebce82eb93570d43343942a1fb10b962"
    ),
    "linux-aarch64-glibc2_17": (
        "quay.io/pypa/manylinux2014_aarch64@"
        "sha256:1145c233b5693c770b878d51e64261603b0d374942ff134d589656799f72e9f9"
    ),
}


def command_for(arguments: list[str]) -> list[str]:
    if len(arguments) < 2:
        raise ValueError("expected an ort-builder command followed by a target")
    target = arguments[1]
    image = MANYLINUX_IMAGES.get(target)
    if image is None:
        return [sys.executable, str(BUILDER_ROOT / "ort-builder"), *arguments]

    if not hasattr(os, "getuid") or not hasattr(os, "getgid"):
        raise RuntimeError(f"{target} requires Docker on a Linux runner")
    container_command = [
        "/opt/python/cp312-cp312/bin/python",
        "-I",
        "-B",
        "/workspace/tools/onnxruntime-build/ort-builder",
        *arguments,
    ]
    return [
        "docker",
        "run",
        "--rm",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--env",
        "HOME=/tmp/wfloat-builder-home",
        "--env",
        "GIT_CONFIG_COUNT=1",
        "--env",
        "GIT_CONFIG_KEY_0=safe.directory",
        "--env",
        "GIT_CONFIG_VALUE_0=/workspace",
        "--volume",
        f"{REPOSITORY}:/workspace",
        "--workdir",
        "/workspace",
        image,
        "bash",
        "-lc",
        shlex.join(container_command),
    ]


def main() -> int:
    arguments = sys.argv[1:]
    try:
        command = command_for(arguments)
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print("+ " + shlex.join(command), flush=True)
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path


BUILDER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = BUILDER_ROOT.parents[1]
# Keep this wrapper independent from builder-package imports: the public
# launcher must perform its clean-tree check before recipe code is imported.
# A contract test keeps these execution constants synchronized with the recipe.
STATIC_CLANG_RELEASE = "v21.1.8.1"
STATIC_CLANG_MANIFEST_SHA256 = "a6f87a4af8d72192219602f252d7debdf7c1e73ca4b28a2f99f2832a3ac0b487"
MANYLINUX_IMAGES = {
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
        raise ValueError("expected an onnxruntime-build command followed by a target")
    target = arguments[1]
    image = MANYLINUX_IMAGES.get(target)
    if image is None:
        return [
            sys.executable,
            "-I",
            "-B",
            str(BUILDER_ROOT / "onnxruntime-build"),
            *arguments,
        ]

    if not hasattr(os, "getuid") or not hasattr(os, "getgid"):
        raise RuntimeError(f"{target} requires Docker on a Linux runner")
    uid = os.getuid()
    gid = os.getgid()
    container_command = [
        "/opt/python/cp312-cp312/bin/python",
        "-I",
        "-B",
        "/workspace/tools/onnxruntime-build/onnxruntime-build",
        *arguments,
    ]
    build = arguments[0] == "build"
    if build:
        installer = [
            "/opt/_internal/build_scripts/install-static-clang-helper.sh",
            "-v",
            STATIC_CLANG_RELEASE,
            "-c",
            STATIC_CLANG_MANIFEST_SHA256,
        ]
        container_command = [
            "setpriv",
            f"--reuid={uid}",
            f"--regid={gid}",
            "--clear-groups",
            "--",
            "env",
            "HOME=/tmp/wfloat-builder-home",
            "GIT_CONFIG_COUNT=1",
            "GIT_CONFIG_KEY_0=safe.directory",
            "GIT_CONFIG_VALUE_0=/workspace",
            "CC=/opt/clang/bin/clang",
            "CXX=/opt/clang/bin/clang++",
            "AR=/opt/clang/bin/llvm-ar",
            "NM=/opt/clang/bin/llvm-nm",
            "RANLIB=/opt/clang/bin/llvm-ranlib",
            "STRIP=/opt/clang/bin/strip",
            "LDFLAGS=-fuse-ld=lld",
            *container_command,
        ]
        shell_command = f"{shlex.join(installer)} && exec {shlex.join(container_command)}"
    else:
        shell_command = shlex.join(container_command)
    return [
        "docker",
        "run",
        "--rm",
        *([] if build else ["--user", f"{uid}:{gid}"]),
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
        shell_command,
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

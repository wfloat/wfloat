#!/usr/bin/env python3
from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path


BUILDER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = BUILDER_ROOT.parents[1]
GCC_PREFIX = "/tmp/wfloat-gcc-11.4.0"
GCC_INSTALLER = BUILDER_ROOT / "ci" / "install_gcc.py"
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


def _require_clean_executable_paths() -> None:
    try:
        relative_builder = BUILDER_ROOT.relative_to(REPOSITORY)
        status = subprocess.run(
            [
                "git",
                "status",
                "--porcelain=v1",
                "--ignored=matching",
                "--untracked-files=all",
                "--",
                str(relative_builder / "onnxruntime_build"),
                str(relative_builder / "ci"),
            ],
            cwd=REPOSITORY,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        raise RuntimeError(
            f"unable to verify executable builder paths before installing GCC: {error}"
        ) from error
    if status:
        raise RuntimeError(
            "dirty, untracked, or ignored files are present in executable builder paths; "
            "remove them before installing GCC:\n" + "\n".join(status)
        )


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
        container_installer = Path("/workspace") / GCC_INSTALLER.relative_to(REPOSITORY)
        installer = [
            "/opt/python/cp312-cp312/bin/python",
            "-I",
            "-B",
            str(container_installer),
            "--prefix",
            GCC_PREFIX,
            "--jobs",
            "4",
        ]
        container_command = [
            "env",
            "HOME=/tmp/wfloat-builder-home",
            "GIT_CONFIG_COUNT=1",
            "GIT_CONFIG_KEY_0=safe.directory",
            "GIT_CONFIG_VALUE_0=/workspace",
            f"CC={GCC_PREFIX}/bin/gcc",
            f"CXX={GCC_PREFIX}/bin/g++",
            f"AR={GCC_PREFIX}/bin/gcc-ar",
            f"NM={GCC_PREFIX}/bin/gcc-nm",
            f"RANLIB={GCC_PREFIX}/bin/gcc-ranlib",
            "STRIP=strip",
            *container_command,
        ]
        runtime_paths = f"{GCC_PREFIX}/lib64:{GCC_PREFIX}/lib"
        shell_command = (
            f"{shlex.join(installer)} && "
            f"export LD_LIBRARY_PATH={shlex.quote(runtime_paths)}"
            "${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} && "
            f"exec {shlex.join(container_command)}"
        )
    else:
        shell_command = shlex.join(container_command)
    return [
        "docker",
        "run",
        "--rm",
        "--user",
        f"{uid}:{gid}",
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


def main(arguments: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        if arguments and arguments[0] == "build":
            _require_clean_executable_paths()
        command = command_for(arguments)
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print("+ " + shlex.join(command), flush=True)
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import os
from pathlib import Path

from ..core import (
    BuildContext,
    CommandPlan,
    Recipe,
    base_build_command,
    finish_test_args,
    require_environment,
)


_COMMON = {
    "platform": "linux",
    "host": "linux",
    "providers": ["cpu"],
    "package": {"kind": "standard", "headers_dir": "include"},
    "validation": {"test_policy": "cross"},
    "verification": "unverified",
}


TARGETS = {
    "linux-arm": {
        **_COMMON,
        "architecture": "arm",
        "linkage": "shared",
        "toolchain": {
            "required_env": ["CC", "CXX", "AR", "WFLOAT_LINUX_SYSROOT", "WFLOAT_PROTOC"]
        },
        "package": {**_COMMON["package"], "required_libraries": ["lib/libonnxruntime.so"]},
    },
    "linux-arm-static_lib": {
        **_COMMON,
        "architecture": "arm",
        "linkage": "static",
        "toolchain": {
            "required_env": ["CC", "CXX", "AR", "WFLOAT_LINUX_SYSROOT", "WFLOAT_PROTOC"]
        },
        "package": {**_COMMON["package"], "required_libraries": ["lib/libonnxruntime.a"]},
        "validation": {"test_policy": "cross"},
    },
    "linux-riscv64-glibc2_17": {
        **_COMMON,
        "architecture": "riscv64",
        "linkage": "shared",
        "toolchain": {
            "glibc": "2.17",
            "required_env": ["RISCV_TOOLCHAIN_ROOT", "WFLOAT_PROTOC"],
        },
        "package": {**_COMMON["package"], "required_libraries": ["lib/libonnxruntime.so"]},
    },
    "linux-riscv64-static_lib": {
        **_COMMON,
        "architecture": "riscv64",
        "linkage": "static",
        "toolchain": {"required_env": ["RISCV_TOOLCHAIN_ROOT", "WFLOAT_PROTOC"]},
        "package": {**_COMMON["package"], "required_libraries": ["lib/libonnxruntime.a"]},
        "validation": {"test_policy": "cross"},
    },
}


def _write_linux_toolchain(build_root: Path, target: dict) -> Path:
    require_environment(["CC", "CXX", "AR", "WFLOAT_LINUX_SYSROOT", "WFLOAT_PROTOC"])
    toolchain_path = build_root / "wfloat-linux-toolchain.cmake"
    processor = {"arm": "armv7", "aarch64": "aarch64"}[target["architecture"]]
    content = "\n".join(
        [
            "set(CMAKE_SYSTEM_NAME Linux)",
            f"set(CMAKE_SYSTEM_PROCESSOR {processor})",
            f"set(CMAKE_C_COMPILER \"{os.environ['CC']}\")",
            f"set(CMAKE_CXX_COMPILER \"{os.environ['CXX']}\")",
            f"set(CMAKE_AR \"{os.environ['AR']}\")",
            f"set(CMAKE_SYSROOT \"{os.environ['WFLOAT_LINUX_SYSROOT']}\")",
            "set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)",
            "",
        ]
    )
    build_root.mkdir(parents=True, exist_ok=True)
    toolchain_path.write_text(content, encoding="utf-8")
    return toolchain_path


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    if target["architecture"] == "riscv64":
        root = os.environ.get("RISCV_TOOLCHAIN_ROOT", "${RISCV_TOOLCHAIN_ROOT}")
        protoc = os.environ.get("WFLOAT_PROTOC", "${WFLOAT_PROTOC}")
        command.extend(["--rv64", f"--riscv_toolchain_root={root}", f"--path_to_protoc_exe={protoc}"])
    else:
        toolchain = (
            context.build_root / "wfloat-linux-toolchain.cmake"
            if context.plan
            else _write_linux_toolchain(context.build_root, target)
        )
        protoc = "${WFLOAT_PROTOC}" if context.plan else os.environ["WFLOAT_PROTOC"]
        command.extend(
            [
                f"--path_to_protoc_exe={protoc}",
                f"--cmake_extra_defines=CMAKE_TOOLCHAIN_FILE={toolchain}",
                "--cmake_extra_defines=onnxruntime_CROSS_COMPILING=ON",
            ]
        )
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("linux_cross", TARGETS, plan)

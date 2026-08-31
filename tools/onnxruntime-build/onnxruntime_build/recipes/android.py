from __future__ import annotations

import os
import re
from pathlib import Path

from ..core import BuildContext, BuildError, CommandPlan, Recipe, base_build_command, finish_test_args


_COMMON = {
    "platform": "android",
    "host": "linux",
    "providers": ["cpu", "nnapi", "xnnpack"],
    "toolchain": {"android_api": 21, "nnapi_min_api": 27, "ndk": "28.0.13004108"},
    "validation": {"test_policy": "cross"},
    "verification": "unverified",
}


TARGETS = {
    "android": {
        **_COMMON,
        "linkage": "shared",
        "architectures": ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"],
        "package": {"kind": "android", "headers_dir": "headers", "library": "libonnxruntime.so"},
        "verification": "verified",
    },
}
for _abi in ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]:
    TARGETS[f"android-{_abi}-static_lib"] = {
        **_COMMON,
        "architecture": _abi,
        "linkage": "static",
        "package": {
            "kind": "standard",
            "headers_dir": "include",
            "required_libraries": ["lib/libonnxruntime.a"],
        },
        "validation": {"test_policy": "cross"},
    }


def _sdk_paths(target: dict) -> tuple[str, str]:
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    ndk = os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    if sdk and not ndk:
        candidate = Path(sdk) / "ndk" / target["toolchain"]["ndk"]
        if candidate.is_dir():
            ndk = str(candidate)
    if not sdk or not ndk:
        raise BuildError("Android builds require ANDROID_HOME (or ANDROID_SDK_ROOT) and ANDROID_NDK_HOME")
    properties = Path(ndk) / "source.properties"
    if not properties.is_file():
        raise BuildError(f"Android NDK source.properties does not exist: {properties}")
    match = re.search(
        r"^Pkg\.Revision\s*=\s*([^\s]+)",
        properties.read_text(encoding="utf-8", errors="replace"),
        re.MULTILINE,
    )
    actual_ndk = match.group(1) if match else None
    expected_ndk = target["toolchain"]["ndk"]
    if actual_ndk != expected_ndk:
        raise BuildError(
            f"target requires Android NDK {expected_ndk}; {properties} reports {actual_ndk or 'unknown'}"
        )
    return sdk, ndk


def plan(target: dict, context: BuildContext) -> CommandPlan:
    sdk, ndk = ("${ANDROID_HOME}", "${ANDROID_NDK_HOME}") if context.plan else _sdk_paths(target)
    abis = target.get("architectures") or [target["architecture"]]
    outputs: dict[str, Path] = {}
    commands: list[list[str]] = []
    for abi in abis:
        build_dir = context.build_root / abi
        command = base_build_command(context.source_dir, build_dir, context.jobs)
        command.extend(
            [
                "--android",
                f"--android_abi={abi}",
                f"--android_api={target['toolchain']['android_api']}",
                f"--android_sdk_path={sdk}",
                f"--android_ndk_path={ndk}",
                "--use_nnapi",
                f"--nnapi_min_api={target['toolchain']['nnapi_min_api']}",
                "--use_xnnpack",
            ]
        )
        if target["linkage"] == "shared":
            command.append("--build_shared_lib")
        commands.append(finish_test_args(command, target, context.skip_tests))
        outputs[abi] = build_dir
    return CommandPlan(outputs, commands)


RECIPE = Recipe("android", TARGETS, plan)

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from ..core import BuildContext, BuildError, CommandPlan, Recipe, tests_enabled


APPLE_TOOLCHAIN = {
    "xcode": "16.4",
    "xcode_build": "16F6",
    "developer_dir": "/Applications/Xcode_16.4.app/Contents/Developer",
}

_COMMON = {
    "platform": "apple",
    "host": "macos",
    "providers": ["cpu", "coreml", "xnnpack"],
    "toolchain": dict(APPLE_TOOLCHAIN),
    "package": {"kind": "xcframework", "bundle": "onnxruntime.xcframework"},
    "validation": {"test_policy": "cross"},
    "verification": "unverified",
}


def apple_preflight(target: dict, source_dir: Path) -> None:
    del source_dir
    toolchain = target["toolchain"]
    expected_dir = toolchain["developer_dir"]
    actual_dir = os.environ.get("DEVELOPER_DIR")
    if actual_dir != expected_dir:
        raise BuildError(
            f"{target['id']} requires DEVELOPER_DIR={expected_dir}; found {actual_dir or 'unset'}"
        )
    try:
        result = subprocess.run(
            ["xcodebuild", "-version"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise BuildError(f"unable to inspect the selected Xcode: {error}") from error
    expected = [f"Xcode {toolchain['xcode']}", f"Build version {toolchain['xcode_build']}"]
    if result.stdout.splitlines()[:2] != expected:
        raise BuildError(
            f"{target['id']} requires {' / '.join(expected)}; found {result.stdout.strip()}"
        )


def _target(linkage: str, slices: dict, minimums: dict, **extra: object) -> dict:
    return {
        **_COMMON,
        "linkage": linkage,
        "slices": slices,
        "minimum_platforms": minimums,
        **extra,
    }


_IOS_SLICES = {"iphoneos": ["arm64"], "iphonesimulator": ["arm64", "x86_64"]}
_IOS_MINIMUMS = {"iphoneos": "13.0", "iphonesimulator": "13.0"}
_IOS_ARCH_MINIMUMS = {"iphonesimulator": {"arm64": "14.0"}}
_MACOS_SLICES = {"macosx": ["arm64", "x86_64"]}
_MACOS_MINIMUMS = {"macosx": "11.0"}
_VISION_SLICES = {"xros": ["arm64"], "xrsimulator": ["arm64"]}
_VISION_MINIMUMS = {"xros": "1.0", "xrsimulator": "1.0"}


TARGETS = {
    "ios-static-xcframework": _target(
        "static",
        _IOS_SLICES,
        _IOS_MINIMUMS,
        minimum_platforms_by_architecture=_IOS_ARCH_MINIMUMS,
    ),
    "ios-shared-xcframework": _target(
        "shared",
        _IOS_SLICES,
        _IOS_MINIMUMS,
        minimum_platforms_by_architecture=_IOS_ARCH_MINIMUMS,
    ),
    "macos-static-xcframework": _target("static", _MACOS_SLICES, _MACOS_MINIMUMS),
    "macos-shared-xcframework": _target("shared", _MACOS_SLICES, _MACOS_MINIMUMS),
    "visionos-static-xcframework": _target(
        "static", _VISION_SLICES, _VISION_MINIMUMS, providers=["cpu", "coreml"]
    ),
    "visionos-shared-xcframework": _target(
        "shared", _VISION_SLICES, _VISION_MINIMUMS, providers=["cpu", "coreml"]
    ),
}


def _platform_args(sysroot: str, minimum: str) -> list[str]:
    if sysroot in {"iphoneos", "iphonesimulator"}:
        return ["--ios", "--use_xcode", "--use_xnnpack", f"--apple_deploy_target={minimum}"]
    if sysroot == "macosx":
        return ["--macos=MacOSX", "--use_xcode", "--use_xnnpack", f"--apple_deploy_target={minimum}"]
    if sysroot in {"xros", "xrsimulator"}:
        return ["--visionos", "--use_xcode", f"--apple_deploy_target={minimum}"]
    raise BuildError(f"unsupported Apple sysroot {sysroot}")


def apple_settings(target: dict, jobs: int, run_tests: bool) -> dict:
    base = [
        f"--parallel={jobs}",
        "--build_apple_framework",
        "--use_coreml",
        "--skip_submodule_sync",
        "--compile_no_warning_as_error",
        "--no_telemetry",
        "--cmake_extra_defines=CMAKE_POLICY_VERSION_MINIMUM=3.5",
    ]
    if not run_tests:
        base.extend(["--skip_tests", "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF"])
    params = {"base": base}
    for sysroot, minimum in target["minimum_platforms"].items():
        params[sysroot] = _platform_args(sysroot, minimum)
    return {"build_osx_archs": target["slices"], "build_params": params}


def plan(target: dict, context: BuildContext) -> CommandPlan:
    run_tests = tests_enabled(target, context.skip_tests)
    settings_path = context.build_root / "apple-build-settings.json"
    if not context.plan:
        context.build_root.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(
            json.dumps(apple_settings(target, context.jobs, run_tests), indent=2) + "\n",
            encoding="utf-8",
        )
    command = [
        sys.executable,
        str(
            context.source_dir
            / "tools"
            / "ci_build"
            / "github"
            / "apple"
            / "build_apple_framework.py"
        ),
        "--config=Release",
        f"--build_dir={context.build_root}",
    ]
    if target["linkage"] == "shared":
        command.append("--build_dynamic_framework")
    command.append(str(settings_path))
    return CommandPlan({"apple": context.build_root}, [command])


RECIPE = Recipe("apple_xcframework", TARGETS, plan, apple_preflight)

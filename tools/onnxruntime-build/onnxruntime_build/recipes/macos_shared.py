from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, base_build_command, finish_test_args, target_architectures
from .apple_xcframework import APPLE_TOOLCHAIN, apple_preflight


_COMMON = {
    "platform": "macos",
    "host": "macos",
    "linkage": "shared",
    "providers": ["cpu", "coreml", "xnnpack"],
    "toolchain": dict(APPLE_TOOLCHAIN),
    "minimum_platform": "11.0",
    "package": {
        "kind": "standard",
        "headers_dir": "include",
        "required_libraries": ["lib/libonnxruntime.dylib"],
    },
    "validation": {"test_policy": "native"},
    "verification": "unverified",
}


TARGETS = {
    "osx-arm64": {**_COMMON, "architecture": "arm64"},
    "osx-x86_64": {**_COMMON, "architecture": "x86_64"},
    "osx-universal2": {**_COMMON, "architectures": ["arm64", "x86_64"]},
}


def plan(target: dict, context: BuildContext) -> CommandPlan:
    architectures = target_architectures(target)
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    command.extend(["--build_shared_lib", "--use_coreml", "--use_xnnpack"])
    if len(architectures) == 1:
        command.append(f"--osx_arch={architectures[0]}")
    else:
        command.append("--cmake_extra_defines=CMAKE_OSX_ARCHITECTURES=arm64;x86_64")
    command.append(
        f"--cmake_extra_defines=CMAKE_OSX_DEPLOYMENT_TARGET={target['minimum_platform']}"
    )
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({"macos": context.build_root}, [command])


RECIPE = Recipe("macos_shared", TARGETS, plan, apple_preflight)

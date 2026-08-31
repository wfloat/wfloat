from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, target_architectures
from .apple_xcframework import APPLE_TOOLCHAIN, apple_preflight, plan as apple_plan


_COMMON = {
    "platform": "macos",
    "host": "macos",
    "linkage": "static",
    "providers": ["cpu", "coreml", "xnnpack"],
    "toolchain": dict(APPLE_TOOLCHAIN),
    "minimum_platform": "11.0",
    "package": {
        "kind": "standard",
        "headers_dir": "include",
        "required_libraries": ["lib/libonnxruntime.a"],
    },
    "validation": {"test_policy": "native"},
    "verification": "unverified",
}


TARGETS = {
    "osx-arm64-static_lib": {**_COMMON, "architecture": "arm64"},
    "osx-x86_64-static_lib": {**_COMMON, "architecture": "x86_64"},
    "osx-universal2-static_lib": {**_COMMON, "architectures": ["arm64", "x86_64"]},
}


def plan(target: dict, context: BuildContext) -> CommandPlan:
    apple_target = dict(target)
    apple_target["slices"] = {"macosx": target_architectures(target)}
    apple_target["minimum_platforms"] = {"macosx": target["minimum_platform"]}
    return apple_plan(apple_target, context)


RECIPE = Recipe("macos_static", TARGETS, plan, apple_preflight)

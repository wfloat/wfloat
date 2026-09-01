from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, base_build_command


TARGETS = {
    "win-arm64x": {
        "platform": "windows",
        "host": "windows",
        "architectures": ["arm64", "arm64ec"],
        "linkage": "shared",
        "providers": ["cpu"],
        "crt": "md",
        "package": {
            "kind": "windows",
            "headers_dir": "include",
            "required_libraries": ["lib/onnxruntime.dll", "lib/onnxruntime.lib"],
        },
        "validation": {"test_policy": "cross"},
        "verification": "unverified",
    }
}


def plan(_target: dict, context: BuildContext) -> CommandPlan:
    arm64_dir = context.build_root / "arm64"
    arm64 = base_build_command(context.source_dir, arm64_dir, context.jobs)
    arm64.extend(["--build_shared_lib", "--arm64", "--buildasx", "--skip_tests"])
    arm64ec = base_build_command(context.source_dir, context.build_root, context.jobs)
    arm64ec.extend(["--build_shared_lib", "--arm64ec", "--buildasx", "--skip_tests"])
    print("Microsoft tests: SKIPPED (ARM64X cross-build); ARM64EC package link validation remains enabled")
    return CommandPlan({"arm64x": context.build_root}, [arm64, arm64ec])


RECIPE = Recipe("windows_arm64x", TARGETS, plan)

from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, base_build_command, finish_test_args


TARGETS = {
    "win-x64-directml": {
        "platform": "windows",
        "host": "windows",
        "architecture": "x64",
        "linkage": "shared",
        "providers": ["cpu", "directml"],
        "crt": "md",
        "package": {
            "kind": "windows",
            "headers_dir": "include",
            "required_libraries": ["lib/onnxruntime.dll", "lib/onnxruntime.lib", "lib/DirectML.dll"],
        },
        "validation": {"test_policy": "gpu-compile"},
    }
}


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    command.extend(["--use_dml", "--build_shared_lib"])
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({"x64": context.build_root}, [command])


RECIPE = Recipe("directml", TARGETS, plan)

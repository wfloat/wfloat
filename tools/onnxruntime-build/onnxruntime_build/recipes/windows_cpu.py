from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, base_build_command, finish_test_args


def _target(architecture: str, linkage: str, crt: str) -> dict:
    if linkage == "shared":
        package = {
            "kind": "windows",
            "headers_dir": "include",
            "required_libraries": ["lib/onnxruntime.dll", "lib/onnxruntime.lib"],
        }
    else:
        package = {
            "kind": "windows-static",
            "headers_dir": "include",
            "required_libraries": [
                "lib/onnxruntime_session.lib",
                "lib/onnxruntime_common.lib",
                "lib/onnxruntime_graph.lib",
                "lib/onnxruntime_framework.lib",
                "lib/onnxruntime_providers.lib",
            ],
        }
    return {
        "platform": "windows",
        "host": "windows",
        "architecture": architecture,
        "linkage": linkage,
        "providers": ["cpu"],
        "crt": crt,
        "package": package,
        "validation": {"test_policy": "native"},
    }


TARGETS: dict[str, dict] = {}
for _architecture in ["x86", "x64", "arm64"]:
    for _linkage in ["shared", "static"]:
        for _crt in ["md", "mt"]:
            _suffix = "" if _linkage == "shared" else "-static_lib"
            TARGETS[f"win-{_architecture}{_suffix}-{_crt}"] = _target(
                _architecture, _linkage, _crt
            )


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    if target["architecture"] == "x86":
        command.append("--x86")
    elif target["architecture"] == "arm64":
        command.append("--arm64")
    if target["crt"] == "mt":
        command.append("--enable_msvc_static_runtime")
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("windows_cpu", TARGETS, plan)

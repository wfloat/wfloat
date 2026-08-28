from __future__ import annotations

from ..core import (
    BuildContext,
    BuildError,
    CommandPlan,
    Recipe,
    base_build_command,
    finish_test_args,
    glibc_version,
    host_architecture,
)


def _target(architecture: str, glibc: str, linkage: str) -> dict:
    library = "lib/libonnxruntime.so" if linkage == "shared" else "lib/libonnxruntime.a"
    suffix = "" if linkage == "shared" else "-static_lib"
    target_id = f"linux-{'x64' if architecture == 'x86_64' else 'aarch64'}{suffix}-glibc{glibc.replace('.', '_')}"
    return {
        "id": target_id,
        "platform": "linux",
        "host": "linux",
        "architecture": architecture,
        "linkage": linkage,
        "providers": ["cpu"],
        "toolchain": {
            "glibc": glibc,
            "native_only": True,
        },
        "package": {
            "kind": "standard",
            "headers_dir": "include",
            "required_libraries": [library],
        },
        "validation": {"test_policy": "native"},
        "verification": "unverified",
    }


TARGETS: dict[str, dict] = {}
for _architecture in ["aarch64", "x86_64"]:
    for _linkage in ["shared", "static"]:
        for _glibc in ["2.17", "2.28"]:
            _definition = _target(_architecture, _glibc, _linkage)
            TARGETS[_definition.pop("id")] = _definition


def preflight(target: dict, _source_dir) -> None:
    architecture = target["architecture"]
    current_arch = host_architecture()
    if architecture not in {current_arch, "x64" if current_arch == "x86_64" else current_arch}:
        return
    actual = glibc_version()
    expected = target["toolchain"]["glibc"]
    if actual != expected:
        image_family = "manylinux2014" if expected == "2.17" else "manylinux_2_28"
        image_arch = "x86_64" if architecture == "x86_64" else "aarch64"
        image = f"quay.io/pypa/{image_family}_{image_arch}"
        raise BuildError(
            f"{target['id']} must be built in glibc {expected}; host reports {actual or 'unknown'}. "
            f"Run the same command in {image}."
        )


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("linux_native", TARGETS, plan, preflight)

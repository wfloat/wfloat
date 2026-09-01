from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

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


GCC_VERSION = "11.4.0"
GCC_SOURCE_URL = "https://gcc.gnu.org/pub/gcc/releases/gcc-11.4.0/gcc-11.4.0.tar.xz"
GCC_SOURCE_SHA512 = (
    "a5018bf1f1fa25ddf33f46e720675d261987763db48e7a5fdf4c26d3150a8abcb"
    "82fdc413402df1c32f2e6b057d9bae6bdfa026defc4030e10144a8532e60f14"
)
MANYLINUX2014_IMAGES = {
    # Pin manifests so the sysroot and supporting tools cannot
    # change underneath a committed artifact-builder revision.
    "x86_64": (
        "quay.io/pypa/manylinux2014_x86_64@"
        "sha256:edb6edbd84c2fa9d40ee83abb160e302ebce82eb93570d43343942a1fb10b962"
    ),
    "aarch64": (
        "quay.io/pypa/manylinux2014_aarch64@"
        "sha256:1145c233b5693c770b878d51e64261603b0d374942ff134d589656799f72e9f9"
    ),
}


def _target(architecture: str, glibc: str, linkage: str) -> dict:
    library = "lib/libonnxruntime.so" if linkage == "shared" else "lib/libonnxruntime.a"
    suffix = "" if linkage == "shared" else "-static_lib"
    target_id = f"linux-{'x64' if architecture == 'x86_64' else 'aarch64'}{suffix}-glibc{glibc.replace('.', '_')}"
    toolchain = {
        "glibc": glibc,
        "native_only": True,
    }
    if glibc == "2.17":
        toolchain.update(
            {
                "container_image": MANYLINUX2014_IMAGES[architecture],
                "compiler": "gcc",
                "compiler_version": GCC_VERSION,
                "compiler_source": GCC_SOURCE_URL,
                "compiler_source_sha512": GCC_SOURCE_SHA512,
                "linker": "bfd",
            }
        )
    return {
        "id": target_id,
        "platform": "linux",
        "host": "linux",
        "architecture": architecture,
        "linkage": linkage,
        "providers": ["cpu"],
        "toolchain": toolchain,
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


def _tool_version(command: str, label: str, pattern: str) -> str:
    executable = shutil.which(command)
    if not executable:
        raise BuildError(f"{label} is not available: {command}")
    try:
        output = subprocess.run(
            [executable, "--version"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BuildError(f"unable to inspect {label}: {executable}") from error
    match = re.search(pattern, output)
    if not match:
        first_line = output.splitlines()[0] if output.splitlines() else "<empty output>"
        raise BuildError(f"unable to parse {label} version from {executable}: {first_line!r}")
    return match.group(1)


def _require_gcc_toolchain(target: dict) -> None:
    toolchain = target["toolchain"]
    expected = toolchain["compiler_version"]
    tools = [
        (os.environ.get("CC", "cc"), "C compiler", r"gcc .*?([0-9]+\.[0-9]+\.[0-9]+)"),
        (os.environ.get("CXX", "c++"), "C++ compiler", r"g\+\+ .*?([0-9]+\.[0-9]+\.[0-9]+)"),
    ]
    for command, label, pattern in tools:
        actual = _tool_version(command, label, pattern)
        if actual != expected:
            raise BuildError(f"{target['id']} requires {label} {expected}; {command} reports {actual}")

    architecture_flags = (
        [
            "-march=armv8.2-a+bf16",
            "-march=armv8.2-a+dotprod",
            "-march=armv8.2-a+fp16",
            "-march=armv8.2-a+i8mm",
        ]
        if target["architecture"] == "aarch64"
        else [None]
    )
    compiler = shutil.which(os.environ.get("CXX", "c++"))
    if not compiler:
        raise BuildError("C++ compiler disappeared after its version was checked")
    with tempfile.TemporaryDirectory(prefix="ort-linux-toolchain-") as temporary_name:
        temporary = Path(temporary_name)
        source = temporary / "probe.cc"
        source.write_text(
            "#include <memory>\n"
            "int main() {\n"
            "  auto value = std::make_unique_for_overwrite<int>();\n"
            "  *value = 0;\n"
            "  return *value;\n"
            "}\n",
            encoding="utf-8",
        )
        for index, architecture_flag in enumerate(architecture_flags):
            output = temporary / f"probe-{index}"
            command = [compiler, "-std=c++20"]
            if architecture_flag:
                command.append(architecture_flag)
            command.extend([str(source), "-o", str(output)])
            try:
                subprocess.run(
                    command,
                    check=True,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
            except (OSError, subprocess.CalledProcessError) as error:
                detail = getattr(error, "stdout", "") or ""
                raise BuildError(
                    f"{target['id']} toolchain cannot compile and link its "
                    f"{architecture_flag or 'native'} probe:\n{detail}"
                ) from error


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
        image = target["toolchain"].get(
            "container_image", f"quay.io/pypa/{image_family}_{image_arch}"
        )
        raise BuildError(
            f"{target['id']} must be built in glibc {expected}; host reports {actual or 'unknown'}. "
            f"Run the same command in {image}."
        )
    if target["toolchain"].get("compiler") == "gcc":
        _require_gcc_toolchain(target)


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("linux_native", TARGETS, plan, preflight)

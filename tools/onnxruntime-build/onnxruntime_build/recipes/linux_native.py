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
BINUTILS_VERSION = "2.42"
BINUTILS_SOURCE_URL = "https://ftp.gnu.org/gnu/binutils/binutils-2.42.tar.xz"
BINUTILS_SOURCE_SHA512 = (
    "155f3ba14cd220102f4f29a4f1e5cfee3c48aa03b74603460d05afb73c70d665"
    "7a9d87eee6eb88bf13203fe6f31177a5c9addc04384e956e7da8069c8ecd20a6"
)
GNU_TOOLCHAIN_PREFIX = (
    f"/tmp/wfloat-gnu-toolchain-gcc-{GCC_VERSION}-binutils-{BINUTILS_VERSION}"
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
                "binutils_version": BINUTILS_VERSION,
                "binutils_source": BINUTILS_SOURCE_URL,
                "binutils_source_sha512": BINUTILS_SOURCE_SHA512,
                "toolchain_prefix": GNU_TOOLCHAIN_PREFIX,
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
        "validation": {
            "test_policy": "package-only" if glibc == "2.17" else "native"
        },
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


def _require_tool(
    prefix: Path,
    command: str,
    executable_name: str,
    label: str,
    pattern: str,
    expected_version: str,
) -> str:
    executable = shutil.which(command)
    if not executable:
        raise BuildError(f"{label} is not available: {command}")
    expected_bin = (prefix / "bin").resolve()
    if Path(executable).parent.resolve() != expected_bin:
        raise BuildError(
            f"{label} must come from {expected_bin}; resolved {command} to {executable}"
        )
    actual = _tool_version(executable, label, pattern)
    if actual != expected_version:
        raise BuildError(
            f"requires {label} {expected_version}; {executable} reports {actual}"
        )
    expected_name = prefix / "bin" / executable_name
    if not expected_name.exists():
        raise BuildError(f"required {label} path does not exist: {expected_name}")
    return executable


def _compiler_program_path(compiler: str, program: str) -> Path:
    try:
        output = subprocess.run(
            [compiler, f"-print-prog-name={program}"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise BuildError(f"unable to resolve {program} selected by {compiler}") from error
    candidate = Path(output)
    if not candidate.is_absolute():
        resolved = shutil.which(output)
        if not resolved:
            raise BuildError(f"{compiler} selected unavailable {program}: {output!r}")
        candidate = Path(resolved)
    return candidate.resolve()


def _run_probe(command: list[str], label: str) -> str:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stdout", "") or ""
        raise BuildError(f"GNU toolchain cannot complete {label}:\n{detail}") from error


def _require_gnu_toolchain(target: dict) -> None:
    toolchain = target["toolchain"]
    prefix = Path(toolchain["toolchain_prefix"])
    compiler_version = toolchain["compiler_version"]
    binutils_version = toolchain["binutils_version"]
    tools = [
        (
            os.environ.get("CC", "cc"),
            "gcc",
            "C compiler",
            r"gcc .*?([0-9]+\.[0-9]+\.[0-9]+)",
            compiler_version,
        ),
        (
            os.environ.get("CXX", "c++"),
            "g++",
            "C++ compiler",
            r"g\+\+ .*?([0-9]+\.[0-9]+\.[0-9]+)",
            compiler_version,
        ),
        (
            os.environ.get("AS", "as"),
            "as",
            "assembler",
            r"GNU assembler .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("LD", "ld"),
            "ld",
            "linker",
            r"GNU ld .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("AR", "gcc-ar"),
            "gcc-ar",
            "archiver",
            r"GNU ar .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("NM", "gcc-nm"),
            "gcc-nm",
            "symbol inspector",
            r"GNU nm .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("RANLIB", "gcc-ranlib"),
            "gcc-ranlib",
            "archive indexer",
            r"GNU ranlib .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("STRIP", "strip"),
            "strip",
            "binary stripper",
            r"GNU strip .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("OBJDUMP", "objdump"),
            "objdump",
            "disassembler",
            r"GNU objdump .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
        (
            os.environ.get("READELF", "readelf"),
            "readelf",
            "ELF inspector",
            r"GNU readelf .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
            binutils_version,
        ),
    ]
    resolved_tools = {
        executable_name: _require_tool(
            prefix,
            command,
            executable_name,
            label,
            pattern,
            expected_version,
        )
        for command, executable_name, label, pattern, expected_version in tools
    }
    compiler = resolved_tools["g++"]
    for program in ("as", "ld"):
        selected = _compiler_program_path(compiler, program)
        expected = (prefix / "bin" / program).resolve()
        if selected != expected:
            raise BuildError(
                f"{compiler} selects {selected} for {program}; expected {expected}"
            )

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
            _run_probe(
                command,
                f"{target['id']} C++20 {architecture_flag or 'native'} compile/link probe",
            )

        if target["architecture"] == "x86_64":
            vnni_source = temporary / "vnni.cc"
            vnni_source.write_text(
                "#include <immintrin.h>\n"
                "extern \"C\" __m256i wfloat_vnni_probe(\n"
                "    __m256i accumulator, __m256i lhs, __m256i rhs) {\n"
                "  return _mm256_dpbusds_avx_epi32(accumulator, lhs, rhs);\n"
                "}\n",
                encoding="utf-8",
            )
            vnni_object = temporary / "vnni.o"
            _run_probe(
                [
                    compiler,
                    "-std=c++20",
                    "-O2",
                    "-mavx2",
                    "-mfma",
                    "-mf16c",
                    "-mavxvnni",
                    "-c",
                    str(vnni_source),
                    "-o",
                    str(vnni_object),
                ],
                f"{target['id']} forced AVX-VNNI assembly probe",
            )
            disassembly = _run_probe(
                [resolved_tools["objdump"], "-d", str(vnni_object)],
                f"{target['id']} AVX-VNNI disassembly probe",
            )
            if not re.search(r"\bvpdpbusds\b", disassembly):
                raise BuildError(
                    f"{target['id']} AVX-VNNI probe did not emit vpdpbusds"
                )


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
        _require_gnu_toolchain(target)


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("linux_native", TARGETS, plan, preflight)

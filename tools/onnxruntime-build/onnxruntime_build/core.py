from __future__ import annotations

import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


class BuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class BuildContext:
    source_dir: Path
    build_root: Path
    jobs: int
    skip_tests: bool
    plan: bool


@dataclass(frozen=True)
class CommandPlan:
    outputs: dict[str, Path]
    commands: list[list[str]]


Preflight = Callable[[dict, Path], None]
Planner = Callable[[dict, BuildContext], CommandPlan]


@dataclass(frozen=True)
class Recipe:
    name: str
    targets: dict[str, dict]
    plan: Planner
    preflight: Preflight | None = None


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("+ " + shlex.join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def capture(command: list[str], *, cwd: Path) -> str:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.strip()


def host() -> str:
    system = platform.system().lower()
    return {"darwin": "macos", "windows": "windows", "linux": "linux"}.get(system, system)


def host_architecture() -> str:
    machine = platform.machine().lower()
    return {
        "amd64": "x86_64",
        "x64": "x86_64",
        "arm64": "aarch64" if host() == "linux" else "arm64",
        "aarch64": "aarch64",
        "i386": "x86",
        "i686": "x86",
    }.get(machine, machine)


def target_architectures(target: dict) -> list[str]:
    if "architectures" in target:
        return list(target["architectures"])
    if "architecture" in target:
        return [target["architecture"]]
    return []


def require_environment(names: Iterable[str]) -> None:
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise BuildError(f"required environment variables are unset: {', '.join(missing)}")


def common_preflight(target: dict) -> None:
    current_host = host()
    portable_recipe = target["recipe"] in {"android", "wasm"}
    if current_host != target["host"] and not (
        portable_recipe and current_host in {"linux", "macos"}
    ):
        raise BuildError(
            f"target {target['id']} requires a {target['host']} build host; current host is {current_host}"
        )
    toolchain = target.get("toolchain", {})
    require_environment(toolchain.get("required_env", []))
    if toolchain.get("native_only") and target.get("architecture") != host_architecture():
        raise BuildError(f"{target['id']} requires a native {target['architecture']} runner")


def glibc_version() -> str | None:
    if host() != "linux":
        return None
    try:
        output = subprocess.run(
            ["ldd", "--version"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.search(r"\b([0-9]+\.[0-9]+)\b", output.splitlines()[0])
    return match.group(1) if match else None


def base_build_command(source_dir: Path, build_dir: Path, jobs: int) -> list[str]:
    command = [
        sys.executable,
        str(source_dir / "tools" / "ci_build" / "build.py"),
        "--config=Release",
        f"--build_dir={build_dir}",
        "--update",
        "--build",
        f"--parallel={jobs}",
        "--skip_submodule_sync",
        "--compile_no_warning_as_error",
        "--no_telemetry",
        "--cmake_extra_defines=CMAKE_POLICY_VERSION_MINIMUM=3.5",
    ]
    if host() != "windows" and shutil.which("ninja"):
        command.append("--cmake_generator=Ninja")
    return command


def tests_enabled(target: dict, skip_tests: bool) -> bool:
    if skip_tests:
        print("Microsoft tests: SKIPPED (--skip-tests was requested)")
        return False
    policy = target["validation"]["test_policy"]
    if policy != "native":
        reason = "cross-compiled target" if policy == "cross" else "GPU runtime requires matching hardware"
        print(f"Microsoft tests: SKIPPED ({reason}); compilation/package validation remains enabled")
        return False
    architectures = target_architectures(target)
    current_arch = host_architecture()
    normalized = ["x86_64" if architecture == "x64" else architecture for architecture in architectures]
    if len(normalized) != 1 or normalized[0] not in {
        current_arch,
        "arm64" if current_arch == "aarch64" else current_arch,
    }:
        print("Microsoft tests: SKIPPED (target cannot execute on this build host)")
        return False
    return True


def finish_test_args(command: list[str], target: dict, skip_tests: bool) -> list[str]:
    if tests_enabled(target, skip_tests):
        command.append("--test")
    else:
        command.extend(["--skip_tests", "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF"])
    return command

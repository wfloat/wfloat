from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from ..core import BuildContext, BuildError, CommandPlan, Recipe, base_build_command, finish_test_args, host


_CUDA_VERSIONS = {
    "12": {"cuda": "12.8", "cudnn": "9.10.2"},
    "13": {"cuda": "13.0", "cudnn": "9.14.0"},
}


def _toolchain(generation: str, *, native_only: bool = False) -> dict:
    result = {
        **_CUDA_VERSIONS[generation],
        "required_env": ["CUDA_HOME", "CUDNN_HOME"],
    }
    if native_only:
        result["native_only"] = True
    return result


def _linux_target(architecture: str, generation: str) -> dict:
    return {
        "platform": "linux",
        "host": "linux",
        "architecture": architecture,
        "linkage": "shared",
        "providers": ["cpu", "cuda"],
        "toolchain": _toolchain(generation, native_only=architecture == "aarch64"),
        "package": {
            "kind": "standard",
            "headers_dir": "include",
            "required_libraries": [
                "lib/libonnxruntime.so",
                "lib/libonnxruntime_providers_shared.so",
                "lib/libonnxruntime_providers_cuda.so",
            ],
        },
        "validation": {"test_policy": "gpu-compile"},
    }


def _windows_target(generation: str) -> dict:
    return {
        "platform": "windows",
        "host": "windows",
        "architecture": "x64",
        "linkage": "shared",
        "providers": ["cpu", "cuda"],
        "crt": "md",
        "toolchain": _toolchain(generation),
        "package": {
            "kind": "windows",
            "headers_dir": "include",
            "required_libraries": [
                "lib/onnxruntime.dll",
                "lib/onnxruntime.lib",
                "lib/onnxruntime_providers_shared.dll",
                "lib/onnxruntime_providers_shared.lib",
                "lib/onnxruntime_providers_cuda.dll",
                "lib/onnxruntime_providers_cuda.lib",
            ],
        },
        "validation": {"test_policy": "gpu-compile"},
    }


TARGETS = {
    "linux-x64-gpu_cuda12": _linux_target("x86_64", "12"),
    "linux-x64-gpu_cuda13": _linux_target("x86_64", "13"),
    "linux-aarch64-gpu_cuda12": _linux_target("aarch64", "12"),
    "linux-aarch64-gpu_cuda13": _linux_target("aarch64", "13"),
    "win-x64-gpu_cuda12": _windows_target("12"),
    "win-x64-gpu_cuda13": _windows_target("13"),
}


def preflight(target: dict, _source_dir: Path) -> None:
    cuda_home = Path(os.environ["CUDA_HOME"])
    cudnn_home = Path(os.environ["CUDNN_HOME"])
    nvcc = cuda_home / "bin" / ("nvcc.exe" if host() == "windows" else "nvcc")
    if not nvcc.is_file():
        raise BuildError(f"CUDA compiler does not exist: {nvcc}")
    result = subprocess.run(
        [str(nvcc), "--version"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    match = re.search(r"\brelease\s+([0-9]+\.[0-9]+)", result.stdout)
    actual_cuda = match.group(1) if match else None
    expected_cuda = target["toolchain"]["cuda"]
    if actual_cuda != expected_cuda:
        raise BuildError(f"target requires CUDA {expected_cuda}; nvcc reports {actual_cuda or 'unknown'}")

    version_headers = [
        cudnn_home / "include" / "cudnn_version.h",
        cudnn_home / "include" / "cudnn_version_v9.h",
    ]
    version_header = next((path for path in version_headers if path.is_file()), None)
    if version_header is None:
        raise BuildError(f"unable to find cudnn_version.h below CUDNN_HOME={cudnn_home}")
    header = version_header.read_text(encoding="utf-8", errors="replace")
    components: list[str] = []
    for macro in ["CUDNN_MAJOR", "CUDNN_MINOR", "CUDNN_PATCHLEVEL"]:
        component = re.search(rf"^\s*#\s*define\s+{macro}\s+([0-9]+)\b", header, re.MULTILINE)
        if not component:
            raise BuildError(f"unable to read {macro} from {version_header}")
        components.append(component.group(1))
    actual_cudnn = ".".join(components)
    expected_cudnn = target["toolchain"]["cudnn"]
    if actual_cudnn != expected_cudnn:
        raise BuildError(f"target requires cuDNN {expected_cudnn}; headers report {actual_cudnn}")


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    command.append("--build_shared_lib")
    command.extend(
        [
            "--use_cuda",
            f"--cuda_version={target['toolchain']['cuda']}",
            f"--cuda_home={os.environ.get('CUDA_HOME', '${CUDA_HOME}')}",
            f"--cudnn_home={os.environ.get('CUDNN_HOME', '${CUDNN_HOME}')}",
        ]
    )
    finish_test_args(command, target, context.skip_tests)
    return CommandPlan({target["architecture"]: context.build_root}, [command])


RECIPE = Recipe("cuda", TARGETS, plan, preflight)

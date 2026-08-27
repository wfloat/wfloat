from __future__ import annotations

import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .catalog import BUILDER_ROOT, DEFAULT_CATALOG_PATH, Catalog
from .package import package_target, sha256
from .source import acquire_source


class BuildError(RuntimeError):
    pass


@dataclass
class BuildResult:
    archive: Path
    microsoft_commit: str
    builder_revision: str
    validation_messages: list[str]


def _run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("+ " + shlex.join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def _capture(command: list[str], *, cwd: Path) -> str:
    return subprocess.run(
        command, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ).stdout.strip()


def _host() -> str:
    system = platform.system().lower()
    return {"darwin": "macos", "windows": "windows", "linux": "linux"}.get(system, system)


def _host_architecture() -> str:
    machine = platform.machine().lower()
    return {
        "amd64": "x86_64",
        "x64": "x86_64",
        "arm64": "aarch64" if _host() == "linux" else "arm64",
        "aarch64": "aarch64",
        "i386": "x86",
        "i686": "x86",
    }.get(machine, machine)


def _builder_revision(require_clean: bool) -> tuple[Path, str]:
    repository = Path(_capture(["git", "rev-parse", "--show-toplevel"], cwd=BUILDER_ROOT))
    commit = _capture(["git", "rev-parse", "HEAD^{commit}"], cwd=repository).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise BuildError("unable to resolve the Wfloat builder commit")
    if require_clean:
        relative_builder = BUILDER_ROOT.relative_to(repository)
        paths = [
            str(relative_builder),
            ".github/workflows/onnxruntime-builder-ci.yml",
            ".github/workflows/onnxruntime-builder-manual.yml",
        ]
        status = _capture(
            ["git", "status", "--porcelain", "--untracked-files=normal", "--", *paths], cwd=repository
        )
        if status:
            raise BuildError(
                "builder source/workflows must be committed before an artifact is named; dirty paths:\n" + status
            )
    return repository, commit[:12]


def _target_architectures(target: dict) -> list[str]:
    if "architectures" in target:
        return list(target["architectures"])
    if "architecture" in target:
        return [target["architecture"]]
    return []


def _check_host(target: dict) -> None:
    host = _host()
    portable_driver = target["driver"] in {"android", "wasm"}
    if host != target["host"] and not (portable_driver and host in {"linux", "macos"}):
        raise BuildError(f"target {target['id']} requires a {target['host']} build host; current host is {host}")


def _require_environment(names: Iterable[str]) -> None:
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise BuildError(f"required environment variables are unset: {', '.join(missing)}")


def _glibc_version() -> str | None:
    if _host() != "linux":
        return None
    try:
        output = subprocess.run(
            ["ldd", "--version"], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.search(r"\b([0-9]+\.[0-9]+)\b", output.splitlines()[0])
    return match.group(1) if match else None


def _validate_cuda_toolchain(target: dict) -> None:
    cuda_home = Path(os.environ["CUDA_HOME"])
    cudnn_home = Path(os.environ["CUDNN_HOME"])
    nvcc = cuda_home / "bin" / ("nvcc.exe" if _host() == "windows" else "nvcc")
    if not nvcc.is_file():
        raise BuildError(f"CUDA compiler does not exist: {nvcc}")
    result = subprocess.run(
        [str(nvcc), "--version"], check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
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


def _preflight(target: dict, source_dir: Path) -> None:
    _check_host(target)
    toolchain = target.get("toolchain", {})
    _require_environment(toolchain.get("required_env", []))

    if target["platform"] == "linux" and toolchain.get("glibc"):
        target_arch = target.get("architecture")
        if target_arch in {_host_architecture(), "x64" if _host_architecture() == "x86_64" else ""}:
            actual = _glibc_version()
            expected = toolchain["glibc"]
            if actual != expected:
                image = toolchain.get("build_environment", "the cataloged build environment")
                raise BuildError(
                    f"{target['id']} must be built in glibc {expected}; host reports {actual or 'unknown'}. "
                    f"Run the same command in {image}."
                )
    if toolchain.get("native_only") and target.get("architecture") != _host_architecture():
        raise BuildError(f"{target['id']} requires a native {target['architecture']} runner")
    if "cuda" in target["providers"]:
        _validate_cuda_toolchain(target)

    if "rocm" in target["providers"]:
        provider_dir = source_dir / "onnxruntime" / "core" / "providers" / "rocm"
        build_args = source_dir / "tools" / "ci_build" / "build_args.py"
        args_text = build_args.read_text(encoding="utf-8", errors="replace") if build_args.is_file() else ""
        if not provider_dir.is_dir() or "--use_rocm" not in args_text:
            raise BuildError(
                f"Microsoft ONNX Runtime commit does not support the requested ROCm provider for {target['id']}; "
                "MIGraphX is a different provider and will not be substituted"
            )


def _base_build_command(source_dir: Path, build_dir: Path, jobs: int) -> list[str]:
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
    if _host() != "windows" and shutil.which("ninja"):
        command.append("--cmake_generator=Ninja")
    return command


def _tests_enabled(target: dict, skip_tests: bool) -> bool:
    if skip_tests:
        print("Microsoft tests: SKIPPED (--skip-tests was requested)")
        return False
    policy = target["validation"]["test_policy"]
    if policy != "native":
        reason = "cross-compiled target" if policy == "cross" else "GPU runtime requires matching hardware"
        print(f"Microsoft tests: SKIPPED ({reason}); compilation/package validation remains enabled")
        return False
    architectures = _target_architectures(target)
    host_arch = _host_architecture()
    normalized = ["x86_64" if arch == "x64" else arch for arch in architectures]
    if len(normalized) != 1 or normalized[0] not in {host_arch, "arm64" if host_arch == "aarch64" else host_arch}:
        print("Microsoft tests: SKIPPED (target cannot execute on this build host)")
        return False
    return True


def _finish_test_args(command: list[str], target: dict, skip_tests: bool) -> list[str]:
    if _tests_enabled(target, skip_tests):
        command.append("--test")
    else:
        command.extend(["--skip_tests", "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF"])
    return command


def _android_sdk_paths(target: dict) -> tuple[str, str]:
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    ndk = os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    if sdk and not ndk:
        candidate = Path(sdk) / "ndk" / target["toolchain"]["ndk"]
        if candidate.is_dir():
            ndk = str(candidate)
    if not sdk or not ndk:
        raise BuildError("Android builds require ANDROID_HOME (or ANDROID_SDK_ROOT) and ANDROID_NDK_HOME")
    properties = Path(ndk) / "source.properties"
    if not properties.is_file():
        raise BuildError(f"Android NDK source.properties does not exist: {properties}")
    match = re.search(
        r"^Pkg\.Revision\s*=\s*([^\s]+)",
        properties.read_text(encoding="utf-8", errors="replace"),
        re.MULTILINE,
    )
    actual_ndk = match.group(1) if match else None
    expected_ndk = target["toolchain"]["ndk"]
    if actual_ndk != expected_ndk:
        raise BuildError(
            f"target requires Android NDK {expected_ndk}; {properties} reports {actual_ndk or 'unknown'}"
        )
    return sdk, ndk


def _build_android(
    target: dict, source_dir: Path, build_root: Path, jobs: int, skip_tests: bool, plan: bool
) -> tuple[dict[str, Path], list[list[str]]]:
    if plan:
        sdk, ndk = "${ANDROID_HOME}", "${ANDROID_NDK_HOME}"
    else:
        sdk, ndk = _android_sdk_paths(target)
    abis = target.get("architectures") or [target["architecture"]]
    outputs: dict[str, Path] = {}
    commands: list[list[str]] = []
    for abi in abis:
        build_dir = build_root / abi
        command = _base_build_command(source_dir, build_dir, jobs)
        command.extend(
            [
                "--android",
                f"--android_abi={abi}",
                f"--android_api={target['toolchain']['android_api']}",
                f"--android_sdk_path={sdk}",
                f"--android_ndk_path={ndk}",
                "--use_nnapi",
                f"--nnapi_min_api={target['toolchain']['nnapi_min_api']}",
                "--use_xnnpack",
            ]
        )
        if target["linkage"] == "shared":
            command.append("--build_shared_lib")
        command = _finish_test_args(command, target, skip_tests)
        commands.append(command)
        outputs[abi] = build_dir
    return outputs, commands


def _apple_platform_args(sysroot: str, minimum: str) -> list[str]:
    if sysroot in {"iphoneos", "iphonesimulator"}:
        return ["--ios", "--use_xcode", "--use_xnnpack", f"--apple_deploy_target={minimum}"]
    if sysroot == "macosx":
        return ["--macos=MacOSX", "--use_xcode", "--use_xnnpack", f"--apple_deploy_target={minimum}"]
    if sysroot in {"xros", "xrsimulator"}:
        return ["--visionos", "--use_xcode", f"--apple_deploy_target={minimum}"]
    raise BuildError(f"unsupported Apple sysroot {sysroot}")


def _apple_settings(target: dict, jobs: int, run_tests: bool) -> dict:
    base = [
        f"--parallel={jobs}",
        "--build_apple_framework",
        "--use_coreml",
        "--skip_submodule_sync",
        "--compile_no_warning_as_error",
        "--no_telemetry",
        "--cmake_extra_defines=CMAKE_POLICY_VERSION_MINIMUM=3.5",
    ]
    if not run_tests:
        base.extend(["--skip_tests", "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF"])
    params = {"base": base}
    for sysroot, minimum in target["minimum_platforms"].items():
        params[sysroot] = _apple_platform_args(sysroot, minimum)
    return {"build_osx_archs": target["slices"], "build_params": params}


def _build_apple_xcframework(
    target: dict,
    source_dir: Path,
    build_root: Path,
    jobs: int,
    skip_tests: bool,
    plan: bool,
    allow_native_tests: bool = False,
) -> tuple[dict[str, Path], list[list[str]]]:
    run_tests = allow_native_tests and _tests_enabled(target, skip_tests)
    settings_path = build_root / "apple-build-settings.json"
    if not plan:
        build_root.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(
            json.dumps(_apple_settings(target, jobs, run_tests), indent=2) + "\n", encoding="utf-8"
        )
    command = [
        sys.executable,
        str(source_dir / "tools" / "ci_build" / "github" / "apple" / "build_apple_framework.py"),
        "--config=Release",
        f"--build_dir={build_root}",
    ]
    if target["linkage"] == "shared":
        command.append("--build_dynamic_framework")
    command.append(str(settings_path))
    if not allow_native_tests:
        print("Microsoft tests: SKIPPED (XCFramework slices are cross-compiled; package metadata is validated)")
    return {"apple": build_root}, [command]


def _build_macos_traditional(
    target: dict, source_dir: Path, build_root: Path, jobs: int, skip_tests: bool, plan: bool
) -> tuple[dict[str, Path], list[list[str]]]:
    architectures = _target_architectures(target)
    if target["linkage"] == "static":
        apple_target = dict(target)
        apple_target["slices"] = {"macosx": architectures}
        apple_target["minimum_platforms"] = {"macosx": target["minimum_platform"]}
        return _build_apple_xcframework(
            apple_target,
            source_dir,
            build_root,
            jobs,
            skip_tests,
            plan,
            allow_native_tests=True,
        )

    command = _base_build_command(source_dir, build_root, jobs)
    command.extend(["--build_shared_lib", "--use_coreml", "--use_xnnpack"])
    if len(architectures) == 1:
        command.append(f"--osx_arch={architectures[0]}")
    else:
        command.append("--cmake_extra_defines=CMAKE_OSX_ARCHITECTURES=arm64;x86_64")
    command.append(f"--cmake_extra_defines=CMAKE_OSX_DEPLOYMENT_TARGET={target['minimum_platform']}")
    command = _finish_test_args(command, target, skip_tests)
    return {"macos": build_root}, [command]


def _write_linux_toolchain(build_root: Path, target: dict) -> Path:
    _require_environment(["CC", "CXX", "AR", "WFLOAT_LINUX_SYSROOT", "WFLOAT_PROTOC"])
    toolchain_path = build_root / "wfloat-linux-toolchain.cmake"
    processor = {"arm": "armv7", "aarch64": "aarch64"}[target["architecture"]]
    content = "\n".join(
        [
            "set(CMAKE_SYSTEM_NAME Linux)",
            f"set(CMAKE_SYSTEM_PROCESSOR {processor})",
            f"set(CMAKE_C_COMPILER \"{os.environ['CC']}\")",
            f"set(CMAKE_CXX_COMPILER \"{os.environ['CXX']}\")",
            f"set(CMAKE_AR \"{os.environ['AR']}\")",
            f"set(CMAKE_SYSROOT \"{os.environ['WFLOAT_LINUX_SYSROOT']}\")",
            "set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)",
            "set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)",
            "",
        ]
    )
    build_root.mkdir(parents=True, exist_ok=True)
    toolchain_path.write_text(content, encoding="utf-8")
    return toolchain_path


def _build_linux(
    target: dict, source_dir: Path, build_root: Path, jobs: int, skip_tests: bool, plan: bool
) -> tuple[dict[str, Path], list[list[str]]]:
    command = _base_build_command(source_dir, build_root, jobs)
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    architecture = target["architecture"]
    host_arch = _host_architecture()
    if architecture == "riscv64":
        root = os.environ.get("RISCV_TOOLCHAIN_ROOT", "${RISCV_TOOLCHAIN_ROOT}")
        protoc = os.environ.get("WFLOAT_PROTOC", "${WFLOAT_PROTOC}")
        command.extend(["--rv64", f"--riscv_toolchain_root={root}", f"--path_to_protoc_exe={protoc}"])
    elif architecture not in {host_arch, "x64" if host_arch == "x86_64" else host_arch}:
        if plan:
            toolchain = build_root / "wfloat-linux-toolchain.cmake"
            protoc = "${WFLOAT_PROTOC}"
        else:
            toolchain = _write_linux_toolchain(build_root, target)
            protoc = os.environ["WFLOAT_PROTOC"]
        command.extend(
            [
                f"--path_to_protoc_exe={protoc}",
                f"--cmake_extra_defines=CMAKE_TOOLCHAIN_FILE={toolchain}",
                "--cmake_extra_defines=onnxruntime_CROSS_COMPILING=ON",
            ]
        )
    if "cuda" in target["providers"]:
        cuda_home = os.environ.get("CUDA_HOME", "${CUDA_HOME}")
        cudnn_home = os.environ.get("CUDNN_HOME", "${CUDNN_HOME}")
        command.extend(
            [
                "--use_cuda",
                f"--cuda_version={target['toolchain']['cuda']}",
                f"--cuda_home={cuda_home}",
                f"--cudnn_home={cudnn_home}",
            ]
        )
    if "rocm" in target["providers"]:
        command.append("--use_rocm")
        if os.environ.get("ROCM_HOME"):
            command.append(f"--rocm_home={os.environ['ROCM_HOME']}")
    command = _finish_test_args(command, target, skip_tests)
    return {architecture: build_root}, [command]


def _windows_target_args(target: dict) -> list[str]:
    architecture = target.get("architecture", "x64")
    args: list[str] = []
    if architecture == "x86":
        args.append("--x86")
    elif architecture == "arm64":
        args.append("--arm64")
    if target.get("crt") == "mt":
        args.append("--enable_msvc_static_runtime")
    if "cuda" in target["providers"]:
        args.extend(
            [
                "--use_cuda",
                f"--cuda_version={target['toolchain']['cuda']}",
                f"--cuda_home={os.environ.get('CUDA_HOME', '${CUDA_HOME}')}",
                f"--cudnn_home={os.environ.get('CUDNN_HOME', '${CUDNN_HOME}')}",
            ]
        )
    if "directml" in target["providers"]:
        args.append("--use_dml")
    return args


def _build_windows(
    target: dict, source_dir: Path, build_root: Path, jobs: int, skip_tests: bool
) -> tuple[dict[str, Path], list[list[str]]]:
    command = _base_build_command(source_dir, build_root, jobs)
    command.extend(_windows_target_args(target))
    if target["linkage"] == "shared":
        command.append("--build_shared_lib")
    command = _finish_test_args(command, target, skip_tests)
    return {target.get("architecture", "arm64x"): build_root}, [command]


def _build_windows_arm64x(
    target: dict, source_dir: Path, build_root: Path, jobs: int
) -> tuple[dict[str, Path], list[list[str]]]:
    arm64_dir = build_root / "arm64"
    arm64 = _base_build_command(source_dir, arm64_dir, jobs)
    arm64.extend(["--build_shared_lib", "--arm64", "--buildasx", "--skip_tests"])
    arm64ec = _base_build_command(source_dir, build_root, jobs)
    arm64ec.extend(["--build_shared_lib", "--arm64ec", "--buildasx", "--skip_tests"])
    print("Microsoft tests: SKIPPED (ARM64X cross-build); ARM64EC package link validation remains enabled")
    return {"arm64x": build_root}, [arm64, arm64ec]


def _build_wasm(
    target: dict, source_dir: Path, build_root: Path, jobs: int
) -> tuple[dict[str, Path], list[list[str]]]:
    command = _base_build_command(source_dir, build_root, jobs)
    command.extend(
        [
            "--build_wasm_static_lib",
            f"--emsdk_version={target['toolchain']['emsdk']}",
            "--disable_rtti",
            "--skip_tests",
            "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF",
            "--cmake_extra_defines=CMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -fno-lto",
            "--cmake_extra_defines=CMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG -fno-lto",
        ]
    )
    if target["features"]["simd"]:
        command.append("--enable_wasm_simd")
    if target["features"]["threads"]:
        command.append("--enable_wasm_threads")
    print("Microsoft tests: SKIPPED (static WebAssembly package target); final-link smoke validation remains enabled")
    return {"wasm32": build_root}, [command]


def _build_ohos(
    target: dict, source_dir: Path, build_root: Path, jobs: int
) -> tuple[dict[str, Path], list[list[str]]]:
    ndk = os.environ.get("OHOS_NDK_HOME", "${OHOS_NDK_HOME}")
    toolchain = Path(ndk) / "build" / "cmake" / "ohos.toolchain.cmake"
    if "${" not in str(toolchain) and not toolchain.is_file():
        raise BuildError(f"OpenHarmony toolchain file does not exist: {toolchain}")
    command = _base_build_command(source_dir, build_root, jobs)
    command.extend(
        [
            "--build_shared_lib",
            f"--cmake_extra_defines=CMAKE_TOOLCHAIN_FILE={toolchain}",
            "--cmake_extra_defines=CMAKE_SYSTEM_NAME=OHOS",
            f"--cmake_extra_defines=OHOS_ARCH={target['architecture']}",
            "--cmake_extra_defines=OHOS_PLATFORM=OHOS",
            f"--cmake_extra_defines=OHOS_SDK_NATIVE={ndk}",
            "--skip_tests",
            "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF",
        ]
    )
    print("Microsoft tests: SKIPPED (OpenHarmony cross-build); package metadata validation remains enabled")
    return {target["architecture"]: build_root}, [command]


def _commands_for_target(
    target: dict,
    source_dir: Path,
    build_root: Path,
    jobs: int,
    skip_tests: bool,
    plan: bool,
) -> tuple[dict[str, Path], list[list[str]]]:
    driver = target["driver"]
    if driver == "android":
        return _build_android(target, source_dir, build_root, jobs, skip_tests, plan)
    if driver == "apple_xcframework":
        return _build_apple_xcframework(target, source_dir, build_root, jobs, skip_tests, plan)
    if driver == "macos_traditional":
        return _build_macos_traditional(target, source_dir, build_root, jobs, skip_tests, plan)
    if driver == "linux":
        return _build_linux(target, source_dir, build_root, jobs, skip_tests, plan)
    if driver == "windows":
        return _build_windows(target, source_dir, build_root, jobs, skip_tests)
    if driver == "windows_arm64x":
        return _build_windows_arm64x(target, source_dir, build_root, jobs)
    if driver == "wasm":
        return _build_wasm(target, source_dir, build_root, jobs)
    if driver == "ohos":
        return _build_ohos(target, source_dir, build_root, jobs)
    raise BuildError(f"unsupported target driver {driver!r}")


def build_target(
    catalog: Catalog,
    target_id: str,
    version: str,
    jobs: int,
    cache_dir: Path,
    work_dir: Path,
    output_dir: Path,
    source_dir: Path | None = None,
    skip_tests: bool = False,
    plan: bool = False,
) -> BuildResult | None:
    if jobs < 1:
        raise BuildError("--jobs must be at least 1")
    if not plan and catalog.path.resolve() != DEFAULT_CATALOG_PATH.resolve():
        raise BuildError("real builds require the committed tools/onnxruntime-build/targets.json catalog")
    target = catalog.target(target_id)
    source_revision = catalog.source_revision(version)
    _, builder_revision = _builder_revision(require_clean=not plan)
    build_root = work_dir.resolve() / target_id / version / builder_revision

    if plan:
        planned_source = source_dir.resolve() if source_dir else Path("/microsoft/onnxruntime")
        outputs, commands = _commands_for_target(
            target, planned_source, build_root, jobs, skip_tests, plan=True
        )
        plan_output = {
            "target": target_id,
            "version": version,
            "source_revision": source_revision,
            "outputs": {key: str(path) for key, path in outputs.items()},
            "commands": commands,
        }
        print(json.dumps(plan_output, indent=2))
        return None

    resolved_source, microsoft_commit = acquire_source(
        cache_dir=cache_dir,
        version=version,
        source_revision=source_revision,
        jobs=jobs,
        source_dir=source_dir,
    )
    print(f"Microsoft ONNX Runtime source commit: {microsoft_commit}")
    print(f"Wfloat builder revision: {builder_revision}")
    _preflight(target, resolved_source)
    outputs, commands = _commands_for_target(
        target, resolved_source, build_root, jobs, skip_tests, plan=False
    )
    for command in commands:
        _run(command, cwd=resolved_source)

    archive = package_target(
        target=target,
        version=version,
        builder_revision=builder_revision,
        source_dir=resolved_source,
        outputs=outputs,
        package_work_dir=build_root / "package",
        output_dir=output_dir,
    )

    from .validate import validate_archive  # Avoid an import cycle during CLI startup.

    validation = validate_archive(catalog, target_id, archive, run_smoke=True, source_dir=resolved_source)
    for message in validation:
        print(message)
    print(f"Archive: {archive}")
    print(f"SHA-256: {sha256(archive)}")
    return BuildResult(
        archive=archive,
        microsoft_commit=microsoft_commit,
        builder_revision=builder_revision,
        validation_messages=validation,
    )

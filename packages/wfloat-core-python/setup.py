#!/usr/bin/env python3

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import setuptools
from setuptools.command.build_py import build_py as _build_py

try:
    from wheel.bdist_wheel import bdist_wheel as _bdist_wheel
except Exception:  # pragma: no cover
    _bdist_wheel = None


ROOT_DIR = Path(__file__).resolve().parent
REPO_ROOT = ROOT_DIR.parents[1]
PACKAGE_NATIVE_DIR = Path("wfloat_core") / "native"

if sys.platform == "darwin":
    os.environ.setdefault("MACOSX_DEPLOYMENT_TARGET", "12.0")


def read_long_description() -> str:
    return (ROOT_DIR / "README.md").read_text(encoding="utf8")


def read_package_version() -> str:
    version_file = ROOT_DIR / "python" / "wfloat_core" / "_version.py"
    namespace = {}
    exec(version_file.read_text(encoding="utf8"), namespace)
    version = namespace.get("__version__")
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError(f"Could not determine package version from {version_file}")
    return version.strip()


def _split_cmake_args(value: str) -> list[str]:
    return [part for part in value.split(" ") if part]


def _default_parallelism() -> str:
    return os.environ.get("WFLOAT_CORE_BUILD_PARALLEL", "2")


def _shared_library_patterns() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("**/wfloat-core.dll", "**/libwfloat-core.dll", "**/*.dll")
    if sys.platform == "darwin":
        return ("**/libwfloat-core.dylib",)
    return ("**/libwfloat-core.so", "**/*.so")


def _is_native_library(path: Path) -> bool:
    if sys.platform == "win32":
        return path.suffix.lower() == ".dll"
    if sys.platform == "darwin":
        return path.name == "libwfloat-core.dylib"
    return path.suffix == ".so" or ".so." in path.name


def _build_native_runtime(build_temp: Path) -> list[Path]:
    if not (REPO_ROOT / "native" / "wfloat-core").exists():
        raise RuntimeError(
            "Could not find the monorepo native/wfloat-core sources. "
            "Build wfloat-core wheels from a full wfloat repository checkout."
        )

    build_temp.mkdir(parents=True, exist_ok=True)
    configure = [
        "cmake",
        "-S",
        str(REPO_ROOT),
        "-B",
        str(build_temp),
        "-DWFLOAT_BUILD_CORE=ON",
        "-DWFLOAT_ENABLE_LLAMA_CPP=ON",
        "-DWFLOAT_CORE_ENABLE_SPEECH=ON",
        "-DSHERPA_ONNX_ENABLE_BINARY=OFF",
        "-DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF",
        "-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF",
        "-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF",
        "-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF",
        "-DSHERPA_ONNX_ENABLE_C_API=ON",
        "-DSHERPA_ONNX_ENABLE_TTS=ON",
    ]

    if sys.platform != "win32":
        configure.append("-DCMAKE_BUILD_TYPE=Release")

    configure.extend(_split_cmake_args(os.environ.get("WFLOAT_CORE_CMAKE_ARGS", "")))

    subprocess.check_call(configure)
    subprocess.check_call(
        [
            "cmake",
            "--build",
            str(build_temp),
            "--target",
            "wfloat-core-shared",
            "--config",
            "Release",
            "--parallel",
            _default_parallelism(),
        ]
    )

    libraries: list[Path] = []
    seen: set[Path] = set()
    for pattern in _shared_library_patterns():
        for path in build_temp.glob(pattern):
            resolved = path.resolve()
            if resolved not in seen and _is_native_library(path):
                seen.add(resolved)
                libraries.append(path)

    primary_names = {"wfloat-core.dll", "libwfloat-core.dll", "libwfloat-core.dylib", "libwfloat-core.so"}
    if not any(path.name in primary_names for path in libraries):
        raise RuntimeError(
            f"CMake build succeeded but no wfloat-core shared library was found in {build_temp}."
        )

    return sorted(libraries, key=lambda path: (path.name not in primary_names, path.name))


class build_py(_build_py):
    def run(self) -> None:
        super().run()

        build_command = self.get_finalized_command("build")
        build_temp = Path(getattr(build_command, "build_temp", "build/temp"))
        libraries = _build_native_runtime(build_temp)

        target_dir = Path(self.build_lib) / PACKAGE_NATIVE_DIR
        target_dir.mkdir(parents=True, exist_ok=True)

        for library in libraries:
            shutil.copy2(library, target_dir / library.name)


if _bdist_wheel is not None:

    class bdist_wheel(_bdist_wheel):
        def finalize_options(self) -> None:
            super().finalize_options()
            self.root_is_pure = False

        def get_tag(self) -> tuple[str, str, str]:
            _, _, platform_tag = super().get_tag()
            return "py3", "none", platform_tag


else:  # pragma: no cover
    bdist_wheel = None


cmdclass = {"build_py": build_py}
if bdist_wheel is not None:
    cmdclass["bdist_wheel"] = bdist_wheel


setuptools.setup(
    name="wfloat-core",
    version=read_package_version(),
    description="Native runtime library for Wfloat Python packages",
    long_description=read_long_description(),
    long_description_content_type="text/markdown",
    author="wfloat",
    license="MIT",
    python_requires=">=3.9",
    url="https://github.com/wfloat/wfloat",
    package_dir={"": "python"},
    packages=setuptools.find_packages(where="python"),
    package_data={
        "wfloat_core": [
            "native/*.dll",
            "native/*.dylib",
            "native/*.so",
            "native/*.so.*",
        ]
    },
    include_package_data=True,
    zip_safe=False,
    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: Microsoft :: Windows",
        "Operating System :: POSIX :: Linux",
        "Operating System :: MacOS :: MacOS X",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
    cmdclass=cmdclass,
)

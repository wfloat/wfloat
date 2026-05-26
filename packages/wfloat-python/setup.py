#!/usr/bin/env python3

from pathlib import Path

import setuptools


ROOT_DIR = Path(__file__).resolve().parent


def read_long_description() -> str:
    return (ROOT_DIR / "README.md").read_text(encoding="utf8")


def read_package_version() -> str:
    version_file = ROOT_DIR / "python" / "wfloat" / "_version.py"
    namespace = {}
    exec(version_file.read_text(encoding="utf8"), namespace)
    version = namespace.get("__version__")
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError(f"Could not determine package version from {version_file}")

    return version.strip()


setuptools.setup(
    name="wfloat",
    version=read_package_version(),
    description="High-level Python wrapper for Wfloat TTS",
    long_description=read_long_description(),
    long_description_content_type="text/markdown",
    author="wfloat",
    license="MIT",
    python_requires=">=3.9",
    url="https://github.com/wfloat/wfloat-python",
    package_dir={"": "python"},
    packages=setuptools.find_packages(where="python"),
    install_requires=[
        "wfloat-core==2.0.0",
    ],
    include_package_data=True,
    entry_points={
        "console_scripts": [
            "wfloat=wfloat._cli:main",
        ]
    },
    zip_safe=False,
    classifiers=[
        "Programming Language :: Python :: 3",
        "Operating System :: Microsoft :: Windows",
        "Operating System :: POSIX :: Linux",
        "Operating System :: MacOS :: MacOS X",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
)

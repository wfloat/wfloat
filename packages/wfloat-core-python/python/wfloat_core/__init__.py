from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import Iterator

from ._version import __version__

_DLL_DIRECTORY_HANDLES = []


def _native_dir() -> Path:
    return Path(__file__).resolve().parent / "native"


def _library_names() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("wfloat-core.dll", "libwfloat-core.dll")
    if sys.platform == "darwin":
        return ("libwfloat-core.dylib",)
    return ("libwfloat-core.so",)


def iter_library_paths() -> Iterator[Path]:
    native_dir = _native_dir()
    for name in _library_names():
        yield native_dir / name


def get_library_path() -> str:
    native_dir = _native_dir()

    if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
        # Keep the handle alive so dependent DLL lookup stays enabled.
        _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(native_dir)))

    for candidate in iter_library_paths():
        if candidate.exists():
            return str(candidate)

    machine = platform.machine() or "unknown"
    names = ", ".join(_library_names())
    raise FileNotFoundError(
        "Could not find the packaged wfloat-core native library. "
        f"Looked in {native_dir} for {names} on {sys.platform}/{machine}."
    )


__all__ = ["__version__", "get_library_path", "iter_library_paths"]

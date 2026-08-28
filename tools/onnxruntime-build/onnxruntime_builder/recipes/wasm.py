from __future__ import annotations

from pathlib import Path

from ..core import BuildContext, BuildError, CommandPlan, Recipe, base_build_command


_COMMON = {
    "platform": "wasm",
    "host": "linux",
    "architecture": "wasm32",
    "linkage": "static",
    "providers": ["cpu"],
    "toolchain": {"emsdk": "4.0.23"},
    "package": {
        "kind": "standard",
        "headers_dir": "include",
        "required_libraries": ["lib/libonnxruntime.a"],
    },
    "validation": {"test_policy": "cross"},
    "verification": "unverified",
}


TARGETS = {
    "wasm-static_lib": {
        **_COMMON,
        "features": {
            "simd": False,
            "threads": False,
            "exception_catching": True,
            "archive_lto": False,
        },
    },
    "wasm-static_lib-simd": {
        **_COMMON,
        "features": {
            "simd": True,
            "threads": False,
            "exception_catching": True,
            "archive_lto": False,
        },
        "verification": "verified",
    },
    "wasm-static_lib-threads": {
        **_COMMON,
        "features": {
            "simd": False,
            "threads": True,
            "exception_catching": True,
            "archive_lto": False,
        },
    },
    "wasm-static_lib-simd-threads": {
        **_COMMON,
        "features": {
            "simd": True,
            "threads": True,
            "exception_catching": True,
            "archive_lto": False,
        },
    },
}


def preflight(target: dict, source_dir: Path) -> None:
    if not target["features"]["exception_catching"]:
        return
    options = source_dir / "cmake" / "CMakeLists.txt"
    flags = source_dir / "cmake" / "adjust_global_compile_flags.cmake"
    options_text = options.read_text(encoding="utf-8", errors="replace") if options.is_file() else ""
    flags_text = flags.read_text(encoding="utf-8", errors="replace") if flags.is_file() else ""
    if "onnxruntime_ENABLE_WEBASSEMBLY_EXCEPTION_CATCHING" not in options_text:
        raise BuildError("Microsoft source lacks the required WebAssembly exception-catching option")
    if (
        "onnxruntime_ENABLE_WEBASSEMBLY_EXCEPTION_CATCHING" not in flags_text
        or "DISABLE_EXCEPTION_CATCHING=0" not in flags_text
    ):
        raise BuildError(
            "Microsoft source no longer maps WebAssembly exception catching to Emscripten catching flags"
        )


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    exception_catching = "ON" if target["features"]["exception_catching"] else "OFF"
    command.extend(
        [
            "--build_wasm_static_lib",
            f"--emsdk_version={target['toolchain']['emsdk']}",
            "--disable_rtti",
            "--skip_tests",
            "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF",
            f"--cmake_extra_defines=onnxruntime_ENABLE_WEBASSEMBLY_EXCEPTION_CATCHING={exception_catching}",
        ]
    )
    if not target["features"]["archive_lto"]:
        command.extend(
            [
                "--cmake_extra_defines=CMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -fno-lto",
                "--cmake_extra_defines=CMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG -fno-lto",
            ]
        )
    if target["features"]["simd"]:
        command.append("--enable_wasm_simd")
    if target["features"]["threads"]:
        command.append("--enable_wasm_threads")
    print("Microsoft tests: SKIPPED (static WebAssembly package target); final-link smoke validation remains enabled")
    return CommandPlan({"wasm32": context.build_root}, [command])


RECIPE = Recipe("wasm", TARGETS, plan, preflight)

from __future__ import annotations

from ..core import BuildContext, CommandPlan, Recipe, base_build_command


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
            "exception_catching": False,
            "archive_lto": False,
        },
    },
    "wasm-static_lib-simd": {
        **_COMMON,
        "features": {
            "simd": True,
            "threads": False,
            "exception_catching": False,
            "archive_lto": False,
        },
    },
    "wasm-static_lib-threads": {
        **_COMMON,
        "features": {
            "simd": False,
            "threads": True,
            "exception_catching": False,
            "archive_lto": False,
        },
    },
    "wasm-static_lib-simd-threads": {
        **_COMMON,
        "features": {
            "simd": True,
            "threads": True,
            "exception_catching": False,
            "archive_lto": False,
        },
    },
}


def plan(target: dict, context: BuildContext) -> CommandPlan:
    command = base_build_command(context.source_dir, context.build_root, context.jobs)
    command.extend(
        [
            "--build_wasm_static_lib",
            f"--emsdk_version={target['toolchain']['emsdk']}",
            "--disable_rtti",
            "--disable_wasm_exception_catching",
            "--skip_tests",
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


RECIPE = Recipe("wasm", TARGETS, plan)

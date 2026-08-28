from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SELECTOR = _load("select_builds", ROOT / "ci" / "select_builds.py")
RUNNER = _load("run_target", ROOT / "ci" / "run_target.py")


ALL_AUTOMATIC_BUILDS = [
    "android",
    "ios-static-xcframework",
    "wasm-static_lib-simd",
    "linux-x64-glibc2_17",
    "linux-aarch64-glibc2_17",
    "osx-arm64-static_lib",
    "osx-x86_64-static_lib",
    "win-x64-static_lib-mt",
]


class CiSelectionTest(unittest.TestCase):
    def test_recipe_change_selects_its_exact_automatic_builds(self) -> None:
        self.assertEqual(
            SELECTOR.select_builds(
                ["tools/onnxruntime-build/onnxruntime_builder/recipes/android.py"]
            ),
            ["android"],
        )
        self.assertEqual(
            SELECTOR.select_builds(
                ["tools/onnxruntime-build/onnxruntime_builder/recipes/linux_native.py"]
            ),
            ["linux-x64-glibc2_17", "linux-aarch64-glibc2_17"],
        )
        self.assertEqual(
            SELECTOR.select_builds(
                ["tools/onnxruntime-build/onnxruntime_builder/recipes/macos_static.py"]
            ),
            ["osx-arm64-static_lib", "osx-x86_64-static_lib"],
        )
        self.assertEqual(
            SELECTOR.select_builds(
                ["tools/onnxruntime-build/onnxruntime_builder/recipes/windows_cpu.py"]
            ),
            ["win-x64-static_lib-mt"],
        )

    def test_recipe_without_automatic_target_selects_no_build(self) -> None:
        self.assertEqual(
            SELECTOR.select_builds(
                ["tools/onnxruntime-build/onnxruntime_builder/recipes/directml.py"]
            ),
            [],
        )

    def test_live_sherpa_link_change_selects_wasm(self) -> None:
        for path in [
            "vendor/sherpa-onnx/build-wasm-simd-speech.sh",
            "vendor/sherpa-onnx/cmake/onnxruntime-wasm-simd.cmake",
            "vendor/sherpa-onnx/wasm/speech/CMakeLists.txt",
        ]:
            with self.subTest(path=path):
                self.assertEqual(
                    SELECTOR.select_builds([path]), ["wasm-static_lib-simd"]
                )

    def test_common_build_change_selects_every_automatic_build(self) -> None:
        for path in [
            "tools/onnxruntime-build/onnxruntime_builder/source.py",
            "tools/onnxruntime-build/onnxruntime_builder/cli.py",
            "tools/onnxruntime-build/ci/run_target.py",
            "tools/onnxruntime-build/ci/select_builds.py",
            "tools/onnxruntime-build/ort-builder",
        ]:
            with self.subTest(path=path):
                self.assertEqual(
                    SELECTOR.select_builds([path]),
                    ALL_AUTOMATIC_BUILDS,
                )

    def test_validator_and_documentation_changes_do_not_select_builds(self) -> None:
        self.assertEqual(
            SELECTOR.select_builds(
                [
                    "tools/onnxruntime-build/onnxruntime_builder/validate.py",
                    "tools/onnxruntime-build/docs/reference/target-catalog.md",
                    "tools/onnxruntime-build/tests/test_package_contract.py",
                ]
            ),
            [],
        )

    def test_matrix_contains_only_recipe_and_exact_target(self) -> None:
        self.assertEqual(
            SELECTOR.matrix_for(["linux-x64-glibc2_17"]),
            {
                "include": [
                    {"recipe": "linux_native", "target": "linux-x64-glibc2_17"}
                ]
            },
        )

    def test_manylinux_targets_run_in_the_matching_container(self) -> None:
        with mock.patch.object(os, "getuid", return_value=501), mock.patch.object(
            os, "getgid", return_value=20
        ):
            x64 = RUNNER.command_for(["build", "linux-x64-glibc2_17", "--jobs", "4"])
            arm64 = RUNNER.command_for(
                ["validate", "linux-aarch64-glibc2_17", "artifact.zip"]
            )
        self.assertEqual(x64[:2], ["docker", "run"])
        self.assertIn(RUNNER.MANYLINUX_IMAGES["linux-x64-glibc2_17"], x64)
        self.assertIn(RUNNER.MANYLINUX_IMAGES["linux-aarch64-glibc2_17"], arm64)
        self.assertIn("@sha256:", RUNNER.MANYLINUX_IMAGES["linux-x64-glibc2_17"])
        self.assertIn(
            "@sha256:", RUNNER.MANYLINUX_IMAGES["linux-aarch64-glibc2_17"]
        )
        self.assertIn("501:20", x64)

    def test_other_targets_use_the_current_runner_python(self) -> None:
        command = RUNNER.command_for(["build", "win-x64-static_lib-mt"])
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(command[-2:], ["build", "win-x64-static_lib-mt"])


if __name__ == "__main__":
    unittest.main()

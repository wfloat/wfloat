from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from onnxruntime_build.catalog import Catalog
from onnxruntime_build.core import BuildError
from onnxruntime_build.recipes.apple_xcframework import apple_preflight
from onnxruntime_build.recipes.linux_native import _require_gcc_toolchain


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]


class AppleToolchainTest(unittest.TestCase):
    def test_preflight_accepts_only_the_cataloged_xcode(self) -> None:
        target = Catalog.load().target("ios-static-xcframework")
        completed = subprocess.CompletedProcess(
            ["xcodebuild", "-version"],
            0,
            stdout="Xcode 16.4\nBuild version 16F6\n",
        )
        with mock.patch.dict(
            os.environ,
            {"DEVELOPER_DIR": "/Applications/Xcode_16.4.app/Contents/Developer"},
        ), mock.patch(
            "onnxruntime_build.recipes.apple_xcframework.subprocess.run",
            return_value=completed,
        ):
            apple_preflight(target, Path("/microsoft/onnxruntime"))

    def test_preflight_rejects_a_different_developer_directory(self) -> None:
        target = Catalog.load().target("osx-arm64-static_lib")
        with mock.patch.dict(os.environ, {"DEVELOPER_DIR": "/Applications/Xcode.app"}):
            with self.assertRaisesRegex(BuildError, "requires DEVELOPER_DIR"):
                apple_preflight(target, Path("/microsoft/onnxruntime"))

    def test_preflight_rejects_a_different_xcode_build(self) -> None:
        target = Catalog.load().target("osx-x86_64-static_lib")
        completed = subprocess.CompletedProcess(
            ["xcodebuild", "-version"],
            0,
            stdout="Xcode 16.4\nBuild version unexpected\n",
        )
        with mock.patch.dict(
            os.environ,
            {"DEVELOPER_DIR": "/Applications/Xcode_16.4.app/Contents/Developer"},
        ), mock.patch(
            "onnxruntime_build.recipes.apple_xcframework.subprocess.run",
            return_value=completed,
        ):
            with self.assertRaisesRegex(BuildError, "requires Xcode 16.4 / Build version 16F6"):
                apple_preflight(target, Path("/microsoft/onnxruntime"))


class LinuxToolchainTest(unittest.TestCase):
    def test_gcc_preflight_proves_cxx20_and_all_aarch64_feature_modes(self) -> None:
        target = Catalog.load().target("linux-aarch64-glibc2_17")
        completed = subprocess.CompletedProcess(["g++"], 0, stdout="")
        with mock.patch.dict(
            os.environ,
            {"CC": "gcc", "CXX": "g++"},
            clear=True,
        ), mock.patch(
            "onnxruntime_build.recipes.linux_native._tool_version",
            side_effect=["11.4.0", "11.4.0"],
        ), mock.patch(
            "onnxruntime_build.recipes.linux_native.shutil.which",
            return_value="/tmp/wfloat-gcc-11.4.0/bin/g++",
        ), mock.patch(
            "onnxruntime_build.recipes.linux_native.subprocess.run",
            return_value=completed,
        ) as run:
            _require_gcc_toolchain(target)

        probes = [call.args[0] for call in run.call_args_list]
        expected_flags = [
            "-march=armv8.2-a+bf16",
            "-march=armv8.2-a+dotprod",
            "-march=armv8.2-a+fp16",
            "-march=armv8.2-a+i8mm",
        ]
        self.assertEqual(len(probes), len(expected_flags))
        for index, expected in enumerate(expected_flags):
            self.assertIn(expected, probes[index])
            for other in set(expected_flags) - {expected}:
                self.assertNotIn(other, probes[index])
        self.assertTrue(all("-std=c++20" in probe for probe in probes))
        self.assertTrue(all("-fuse-ld=lld" not in probe for probe in probes))

    def test_gcc_preflight_rejects_toolchain_drift(self) -> None:
        target = Catalog.load().target("linux-x64-glibc2_17")
        with mock.patch(
            "onnxruntime_build.recipes.linux_native._tool_version",
            side_effect=["11.4.0", "12.1.0"],
        ), self.assertRaisesRegex(BuildError, "requires C\\+\\+ compiler 11.4.0"):
            _require_gcc_toolchain(target)


class WasmConsumerContractTest(unittest.TestCase):
    def test_live_consumer_uses_only_the_published_registry_pin(self) -> None:
        consumer = (
            REPOSITORY / "vendor" / "sherpa-onnx" / "cmake" / "onnxruntime-wasm-simd.cmake"
        ).read_text(encoding="utf-8")
        self.assertIn('set(onnxruntime_version "1.23.2")', consumer)
        self.assertIn(
            'set(onnxruntime_URL "https://registry.wfloat.com/onnxruntime-wasm-static_lib-simd/${onnxruntime_filename}")',
            consumer,
        )
        self.assertIn(
            'set(onnxruntime_HASH "SHA256=a61d69a400911a175650dceb8a9b472ec9970326bc766c345924283dbb45d1fe")',
            consumer,
        )
        self.assertNotIn("WFLOAT_ONNXRUNTIME_WASM", consumer)
        self.assertNotIn("wasm-consumer-override", consumer)

    def test_live_sherpa_link_keeps_exception_catching_disabled(self) -> None:
        speech = (
            REPOSITORY / "vendor" / "sherpa-onnx" / "wasm" / "speech" / "CMakeLists.txt"
        ).read_text(encoding="utf-8")
        common = (
            REPOSITORY / "vendor" / "sherpa-onnx" / "wasm" / "wasm-common.cmake"
        ).read_text(encoding="utf-8")
        self.assertNotIn("DISABLE_EXCEPTION_CATCHING=0", speech)
        self.assertNotIn("DISABLE_EXCEPTION_CATCHING=0", common)


if __name__ == "__main__":
    unittest.main()

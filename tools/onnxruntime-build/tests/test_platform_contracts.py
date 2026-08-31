from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from onnxruntime_build.catalog import Catalog
from onnxruntime_build.core import BuildError
from onnxruntime_build.recipes.apple_xcframework import apple_preflight


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

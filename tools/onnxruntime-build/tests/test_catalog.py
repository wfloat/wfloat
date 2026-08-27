from __future__ import annotations

import unittest
from pathlib import Path

from onnxruntime_builder.catalog import Catalog


EXPECTED_TARGETS = {
    "android",
    "android-arm64-v8a-static_lib",
    "android-armeabi-v7a-static_lib",
    "android-x86-static_lib",
    "android-x86_64-static_lib",
    "ios-static-xcframework",
    "ios-shared-xcframework",
    "macos-static-xcframework",
    "macos-shared-xcframework",
    "visionos-static-xcframework",
    "visionos-shared-xcframework",
    "osx-arm64",
    "osx-arm64-static_lib",
    "osx-x86_64",
    "osx-x86_64-static_lib",
    "osx-universal2",
    "osx-universal2-static_lib",
    "linux-arm",
    "linux-arm-static_lib",
    "linux-aarch64-glibc2_17",
    "linux-aarch64-glibc2_28",
    "linux-aarch64-static_lib-glibc2_17",
    "linux-aarch64-static_lib-glibc2_28",
    "linux-x64-glibc2_17",
    "linux-x64-glibc2_28",
    "linux-x64-static_lib-glibc2_17",
    "linux-x64-static_lib-glibc2_28",
    "linux-riscv64-glibc2_17",
    "linux-riscv64-static_lib",
    "linux-x64-gpu_cuda12",
    "linux-x64-gpu_cuda13",
    "linux-aarch64-gpu_cuda12",
    "linux-aarch64-gpu_cuda13",
    "linux-x64-rocm",
    "win-x86-md",
    "win-x86-mt",
    "win-x86-static_lib-md",
    "win-x86-static_lib-mt",
    "win-x64-md",
    "win-x64-mt",
    "win-x64-static_lib-md",
    "win-x64-static_lib-mt",
    "win-arm64-md",
    "win-arm64-mt",
    "win-arm64-static_lib-md",
    "win-arm64-static_lib-mt",
    "win-arm64x",
    "win-x64-gpu_cuda12",
    "win-x64-gpu_cuda13",
    "win-x64-directml",
    "wasm-static_lib",
    "wasm-static_lib-simd",
    "wasm-static_lib-threads",
    "wasm-static_lib-simd-threads",
    "ohos-arm64-v8a",
    "ohos-armeabi-v7a",
    "ohos-x86_64",
}


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = Catalog.load()

    def test_complete_target_catalog(self) -> None:
        self.assertEqual(set(self.catalog.target_ids), EXPECTED_TARGETS)
        self.assertEqual(len(self.catalog.target_ids), 57)

    def test_default_source_contract(self) -> None:
        self.assertEqual(self.catalog.default_version, "1.29.0")
        self.assertEqual(
            self.catalog.source_repository,
            "https://github.com/microsoft/onnxruntime.git",
        )

    def test_ios_consumer_compatibility_is_explicit(self) -> None:
        target = self.catalog.target("ios-static-xcframework")
        self.assertEqual(target["minimum_platforms"]["iphoneos"], "13.0")
        self.assertEqual(target["minimum_platforms"]["iphonesimulator"], "13.0")
        self.assertEqual(target["slices"]["iphoneos"], ["arm64"])
        self.assertEqual(target["slices"]["iphonesimulator"], ["arm64", "x86_64"])

    def test_cuda_compatibility_is_exact_and_tensorrt_is_off(self) -> None:
        cuda12 = self.catalog.target("linux-x64-gpu_cuda12")["toolchain"]
        cuda13 = self.catalog.target("win-x64-gpu_cuda13")["toolchain"]
        self.assertEqual(cuda12["cuda"], "12.8")
        self.assertEqual(cuda12["cudnn"], "9.10.2")
        self.assertFalse(cuda12["tensorrt"])
        self.assertEqual(cuda13["cuda"], "13.0")
        self.assertEqual(cuda13["cudnn"], "9.14.0")
        self.assertFalse(cuda13["tensorrt"])

    def test_wasm_variants_do_not_enable_lto(self) -> None:
        for target_id in sorted(name for name in EXPECTED_TARGETS if name.startswith("wasm-")):
            target = self.catalog.target(target_id)
            self.assertFalse(target["toolchain"]["lto"])
            self.assertEqual(target["architecture"], "wasm32")

    def test_windows_crt_is_in_target_identity(self) -> None:
        self.assertEqual(self.catalog.target("win-x64-static_lib-mt")["crt"], "mt")
        self.assertEqual(self.catalog.target("win-x64-static_lib-md")["crt"], "md")

    def test_rocm_is_not_declared_as_migraphx(self) -> None:
        target = self.catalog.target("linux-x64-rocm")
        self.assertIn("rocm", target["providers"])
        self.assertNotIn("migraphx", target["providers"])

    def test_manual_workflow_addresses_every_target(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        workflow = (repository / ".github" / "workflows" / "onnxruntime-builder-manual.yml").read_text(
            encoding="utf-8"
        )
        target_options = workflow.split("      target:\n", 1)[1].split("      version:\n", 1)[0]
        options = {
            line.strip().removeprefix("- ")
            for line in target_options.splitlines()
            if line.strip().startswith("- ")
        }
        self.assertEqual(options, EXPECTED_TARGETS)

    def test_builder_workflows_are_read_only_and_do_not_publish(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        for name in ["onnxruntime-builder-ci.yml", "onnxruntime-builder-manual.yml"]:
            workflow = (repository / ".github" / "workflows" / name).read_text(encoding="utf-8")
            self.assertIn("permissions:\n  contents: read", workflow)
            self.assertNotIn("id-token: write", workflow)
            self.assertNotIn("publish", workflow.lower())


if __name__ == "__main__":
    unittest.main()

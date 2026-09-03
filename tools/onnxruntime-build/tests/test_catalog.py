from __future__ import annotations

import unittest

from onnxruntime_build.catalog import Catalog


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
}


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = Catalog.load()

    def test_complete_target_catalog(self) -> None:
        self.assertEqual(set(self.catalog.target_ids), EXPECTED_TARGETS)
        self.assertEqual(len(self.catalog.target_ids), 53)

    def test_default_source_contract(self) -> None:
        self.assertEqual(self.catalog.default_version, "1.29.0")
        self.assertEqual(
            self.catalog.source_repository,
            "https://github.com/microsoft/onnxruntime.git",
        )
        self.assertEqual(
            self.catalog.source_revision("1.29.0"),
            "2e2543fbe9fae542f921d47a72d21d5a4ef0b710",
        )

    def test_visionos_provider_contract_matches_microsoft_framework_defaults(self) -> None:
        for target_id in ["visionos-static-xcframework", "visionos-shared-xcframework"]:
            with self.subTest(target=target_id):
                self.assertEqual(self.catalog.target(target_id)["providers"], ["cpu", "coreml"])

    def test_android_ndk_matches_microsoft_workflows(self) -> None:
        for target_id in ["android", "android-arm64-v8a-static_lib"]:
            with self.subTest(target=target_id):
                self.assertEqual(
                    self.catalog.target(target_id)["toolchain"]["ndk"],
                    "28.0.13004108",
                )

    def test_ios_consumer_compatibility_is_explicit(self) -> None:
        target = self.catalog.target("ios-static-xcframework")
        self.assertEqual(target["minimum_platforms"]["iphoneos"], "13.0")
        self.assertEqual(target["minimum_platforms"]["iphonesimulator"], "13.0")
        self.assertEqual(
            target["minimum_platforms_by_architecture"]["iphonesimulator"]["arm64"],
            "14.0",
        )
        self.assertEqual(target["slices"]["iphoneos"], ["arm64"])
        self.assertEqual(target["slices"]["iphonesimulator"], ["arm64", "x86_64"])

    def test_apple_toolchain_is_exact(self) -> None:
        expected = {
            "xcode": "16.4",
            "xcode_build": "16F6",
            "developer_dir": "/Applications/Xcode_16.4.app/Contents/Developer",
        }
        for target in self.catalog.targets():
            if target["host"] == "macos":
                with self.subTest(target=target["id"]):
                    self.assertEqual(target["toolchain"], expected)

    def test_compatibility_floor_targets_use_package_only_validation(self) -> None:
        for target_id in [
            "osx-arm64-static_lib",
            "osx-x86_64-static_lib",
            "osx-universal2-static_lib",
        ]:
            with self.subTest(target=target_id):
                self.assertEqual(
                    self.catalog.target(target_id)["validation"]["test_policy"],
                    "package-only",
                )

        self.assertEqual(
            self.catalog.target("osx-arm64")["validation"]["test_policy"],
            "native",
        )
        for target_id in [
            "linux-x64-glibc2_17",
            "linux-x64-static_lib-glibc2_17",
            "linux-aarch64-glibc2_17",
            "linux-aarch64-static_lib-glibc2_17",
        ]:
            with self.subTest(target=target_id):
                self.assertEqual(
                    self.catalog.target(target_id)["validation"]["test_policy"],
                    "package-only",
                )
        self.assertEqual(
            self.catalog.target("linux-x64-glibc2_28")["validation"]["test_policy"],
            "native",
        )
        self.assertEqual(
            self.catalog.target("win-x64-static_lib-mt")["validation"]["test_policy"],
            "native",
        )

    def test_cuda_compatibility_is_exact(self) -> None:
        cuda12 = self.catalog.target("linux-x64-gpu_cuda12")["toolchain"]
        cuda13 = self.catalog.target("win-x64-gpu_cuda13")["toolchain"]
        self.assertEqual(cuda12["cuda"], "12.8")
        self.assertEqual(cuda12["cudnn"], "9.10.2")
        self.assertEqual(cuda13["cuda"], "13.0")
        self.assertEqual(cuda13["cudnn"], "9.14.0")

    def test_wasm_variants_do_not_enable_lto(self) -> None:
        for target_id in sorted(name for name in EXPECTED_TARGETS if name.startswith("wasm-")):
            target = self.catalog.target(target_id)
            self.assertFalse(target["features"]["archive_lto"])
            self.assertFalse(target["features"]["exception_catching"])
            self.assertEqual(target["architecture"], "wasm32")

    def test_windows_crt_is_in_target_identity(self) -> None:
        self.assertEqual(self.catalog.target("win-x64-static_lib-mt")["crt"], "mt")
        self.assertEqual(self.catalog.target("win-x64-static_lib-md")["crt"], "md")

    def test_unavailable_rocm_and_openharmony_contracts_are_not_build_targets(self) -> None:
        self.assertNotIn("linux-x64-rocm", self.catalog.target_ids)
        self.assertFalse(any(target.startswith("ohos-") for target in self.catalog.target_ids))

    def test_recipe_field_is_enforced_and_resolved(self) -> None:
        self.assertEqual(self.catalog.target("android")["recipe"], "android")
        self.assertEqual(self.catalog.target("win-x64-directml")["recipe"], "directml")
        self.assertEqual(self.catalog.recipe("wasm-static_lib-simd").name, "wasm")

    def test_source_lock_is_small_and_separate_from_recipe_catalog(self) -> None:
        self.assertEqual(
            set(self.catalog.source_lock), {"repository", "default_version", "revisions"}
        )
        self.assertNotIn("targets", self.catalog.source_lock)


if __name__ == "__main__":
    unittest.main()

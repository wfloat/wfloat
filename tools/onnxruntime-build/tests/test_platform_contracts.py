from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from onnxruntime_build.catalog import Catalog
from onnxruntime_build.core import BuildError
from onnxruntime_build.recipes.apple_xcframework import apple_preflight
from onnxruntime_build.recipes.linux_native import (
    _require_gnu_toolchain,
    _require_tool,
)


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
    @staticmethod
    def _resolved_tools(target: dict) -> list[str]:
        prefix = target["toolchain"]["toolchain_prefix"]
        return [
            f"{prefix}/bin/gcc",
            f"{prefix}/bin/g++",
            f"{prefix}/bin/as",
            f"{prefix}/bin/ld",
            f"{prefix}/bin/gcc-ar",
            f"{prefix}/bin/gcc-nm",
            f"{prefix}/bin/gcc-ranlib",
            f"{prefix}/bin/strip",
            f"{prefix}/bin/objdump",
            f"{prefix}/bin/readelf",
        ]

    def test_gnu_preflight_proves_cxx20_and_all_aarch64_feature_modes(self) -> None:
        target = Catalog.load().target("linux-aarch64-glibc2_17")
        prefix = Path(target["toolchain"]["toolchain_prefix"])
        with (
            mock.patch(
                "onnxruntime_build.recipes.linux_native._require_tool",
                side_effect=self._resolved_tools(target),
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._compiler_program_path",
                side_effect=[
                    (prefix / "bin" / "as").resolve(),
                    (prefix / "bin" / "ld").resolve(),
                ],
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._run_probe",
                return_value="",
            ) as run_probe,
        ):
            _require_gnu_toolchain(target)

        probes = [call.args[0] for call in run_probe.call_args_list]
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

    def test_gnu_preflight_forces_and_disassembles_vnni(self) -> None:
        target = Catalog.load().target("linux-x64-glibc2_17")
        prefix = Path(target["toolchain"]["toolchain_prefix"])
        observed_source: list[str] = []

        def run_probe(command: list[str], label: str) -> str:
            if "forced AVX-VNNI" in label:
                observed_source.append(
                    Path(command[command.index("-c") + 1]).read_text(encoding="utf-8")
                )
            if "disassembly" in label:
                return "0000: vpdpbusds %ymm0,%ymm1,%ymm2"
            return ""

        with (
            mock.patch(
                "onnxruntime_build.recipes.linux_native._require_tool",
                side_effect=self._resolved_tools(target),
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._compiler_program_path",
                side_effect=[
                    (prefix / "bin" / "as").resolve(),
                    (prefix / "bin" / "ld").resolve(),
                ],
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._run_probe",
                side_effect=run_probe,
            ) as run_probe,
        ):
            _require_gnu_toolchain(target)

        probes = [call.args[0] for call in run_probe.call_args_list]
        self.assertEqual(len(probes), 3)
        self.assertIn("-mavxvnni", probes[1])
        self.assertIn("-c", probes[1])
        self.assertEqual(probes[2][0], f"{prefix}/bin/objdump")
        self.assertEqual(probes[2][1], "-d")
        self.assertEqual(len(observed_source), 1)
        self.assertIn("_mm256_dpbusds_avx_epi32", observed_source[0])

    def test_gnu_preflight_rejects_a_false_positive_vnni_probe(self) -> None:
        target = Catalog.load().target("linux-x64-glibc2_17")
        prefix = Path(target["toolchain"]["toolchain_prefix"])
        with (
            mock.patch(
                "onnxruntime_build.recipes.linux_native._require_tool",
                side_effect=self._resolved_tools(target),
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._compiler_program_path",
                side_effect=[
                    (prefix / "bin" / "as").resolve(),
                    (prefix / "bin" / "ld").resolve(),
                ],
            ),
            mock.patch(
                "onnxruntime_build.recipes.linux_native._run_probe",
                side_effect=["", "", "no matching instruction"],
            ),
            self.assertRaisesRegex(BuildError, "did not emit vpdpbusds"),
        ):
            _require_gnu_toolchain(target)

    def test_required_tool_rejects_version_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name)
            (prefix / "bin").mkdir()
            compiler = prefix / "bin" / "g++"
            compiler.touch()
            with (
                mock.patch(
                    "onnxruntime_build.recipes.linux_native.shutil.which",
                    return_value=str(compiler),
                ),
                mock.patch(
                    "onnxruntime_build.recipes.linux_native._tool_version",
                    return_value="12.1.0",
                ),
                self.assertRaisesRegex(BuildError, "requires C\\+\\+ compiler 11.4.0"),
            ):
                _require_tool(
                    prefix,
                    str(compiler),
                    "g++",
                    "C++ compiler",
                    r"g\\+\\+ (.*)",
                    "11.4.0",
                )


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

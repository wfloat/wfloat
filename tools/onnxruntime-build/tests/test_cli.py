from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from onnxruntime_build.catalog import Catalog


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "onnxruntime-build"


class CliTest(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(CLI), *args],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_list_targets_json(self) -> None:
        result = self.run_cli("list", "targets", "--platform", "wasm", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        targets = json.loads(result.stdout)
        self.assertEqual(len(targets), 4)
        self.assertTrue(all(target["platform"] == "wasm" for target in targets))

    def test_plan_covers_every_target(self) -> None:
        catalog = Catalog.load()
        for target in catalog.target_ids:
            with self.subTest(target=target):
                result = self.run_cli("build", target, "--plan", "--jobs", "2")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'"target": "{target}"', result.stdout)
                self.assertIn(
                    '"source_revision": "2e2543fbe9fae542f921d47a72d21d5a4ef0b710"',
                    result.stdout,
                )
                self.assertRegex(result.stdout, r"tools/ci_build/(?:github/apple/)?build")

    def test_invalid_target_is_rejected(self) -> None:
        result = self.run_cli("build", "not-a-target", "--plan")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)

    def test_wasm_release_plan_explicitly_disables_archive_lto(self) -> None:
        result = self.run_cli("build", "wasm-static_lib-simd", "--plan")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("-fno-lto"), 2)

    def test_wasm_release_plan_explicitly_disables_exception_catching(self) -> None:
        result = self.run_cli("build", "wasm-static_lib-simd", "--plan")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--disable_wasm_exception_catching", result.stdout)
        self.assertNotIn(
            "onnxruntime_ENABLE_WEBASSEMBLY_EXCEPTION_CATCHING=ON",
            result.stdout,
        )

    def test_cuda_plan_does_not_enable_tensorrt(self) -> None:
        result = self.run_cli("build", "linux-x64-gpu_cuda12", "--plan")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--use_cuda", result.stdout)
        self.assertNotIn("tensorrt", result.stdout.lower())

    def test_unpinned_version_is_rejected_even_for_plan(self) -> None:
        result = self.run_cli(
            "build", "wasm-static_lib-simd", "--version", "1.30.0", "--plan"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no committed source revision", result.stderr)

    def test_arbitrary_source_ref_option_is_not_accepted(self) -> None:
        result = self.run_cli(
            "build",
            "wasm-static_lib-simd",
            "--plan",
            "--source-ref",
            "0123456789abcdef0123456789abcdef01234567",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrecognized arguments: --source-ref", result.stderr)

    def test_arbitrary_catalog_option_is_not_accepted(self) -> None:
        result = self.run_cli("--catalog", "/tmp/alternate-targets.json", "list", "targets")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)

    def test_list_and_plan_allow_ignored_executable_builder_files(self) -> None:
        cache = ROOT / "onnxruntime_build/__pycache__"
        injected = cache / "injected.pyc"
        cache.mkdir(exist_ok=True)
        injected.write_bytes(b"not trusted builder code")
        try:
            listed = self.run_cli("list", "targets")
            self.assertEqual(listed.returncode, 0, listed.stderr)
            planned = self.run_cli("build", "wasm-static_lib-simd", "--plan")
            self.assertEqual(planned.returncode, 0, planned.stderr)
        finally:
            injected.unlink(missing_ok=True)
            try:
                cache.rmdir()
            except OSError:
                pass

    def test_real_build_rejects_ignored_code_before_recipe_import(self) -> None:
        cache = ROOT / "onnxruntime_build/__pycache__"
        injected = cache / "injected.pyc"
        cache.mkdir(exist_ok=True)
        injected.write_bytes(b"not trusted builder code")
        try:
            result = self.run_cli("build", "wasm-static_lib-simd")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "dirty, untracked, or ignored files are present in executable builder paths",
                result.stderr,
            )
        finally:
            injected.unlink(missing_ok=True)
            try:
                cache.rmdir()
            except OSError:
                pass

    def test_real_build_rejects_untracked_code_before_recipe_import(self) -> None:
        injected = ROOT / "onnxruntime_build/injected_extension.so"
        injected.write_bytes(b"not trusted builder code")
        try:
            result = self.run_cli("build", "wasm-static_lib-simd")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "dirty, untracked, or ignored files are present in executable builder paths",
                result.stderr,
            )
        finally:
            injected.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()

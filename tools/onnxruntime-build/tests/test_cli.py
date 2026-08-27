from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "ort-builder"


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

    def test_plan_covers_each_build_driver(self) -> None:
        representatives = [
            "android-arm64-v8a-static_lib",
            "ios-static-xcframework",
            "osx-arm64",
            "linux-x64-glibc2_17",
            "win-x64-static_lib-mt",
            "win-arm64x",
            "wasm-static_lib-simd",
            "ohos-arm64-v8a",
        ]
        for target in representatives:
            with self.subTest(target=target):
                result = self.run_cli("build", target, "--plan", "--jobs", "2")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'"target": "{target}"', result.stdout)
                self.assertRegex(result.stdout, r"tools/ci_build/(?:github/apple/)?build")

    def test_invalid_target_is_rejected(self) -> None:
        result = self.run_cli("build", "not-a-target", "--plan")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid choice", result.stderr)


if __name__ == "__main__":
    unittest.main()

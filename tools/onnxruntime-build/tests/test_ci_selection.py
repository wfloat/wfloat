from __future__ import annotations

import fnmatch
import importlib.util
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from onnxruntime_build.catalog import Catalog


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
WORKFLOWS = REPOSITORY / ".github" / "workflows"
ARTIFACT_ACTION = REPOSITORY / ".github" / "actions" / "onnxruntime-artifact" / "action.yml"
EXPECTED_AUTOMATIC_TARGETS = {
    "android",
    "ios-static-xcframework",
    "wasm-static_lib-simd",
    "linux-x64-glibc2_17",
    "linux-aarch64-glibc2_17",
    "osx-arm64-static_lib",
    "osx-x86_64-static_lib",
    "win-x64-static_lib-mt",
}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _workflow_selects(text: str, changed_path: str) -> bool:
    selected = False
    patterns = re.findall(r'^\s+- "(!?[^"\n]+)"\s*$', text, re.MULTILINE)
    for pattern in patterns:
        excluded = pattern.startswith("!")
        candidate = pattern[1:] if excluded else pattern
        if fnmatch.fnmatchcase(changed_path, candidate):
            selected = not excluded
    return selected


RUNNER = _load("run_target", ROOT / "ci" / "run_target.py")
GCC_INSTALLER = _load("install_gcc", ROOT / "ci" / "install_gcc.py")

FAMILIES = {
    "onnxruntime-builder-android.yml": {
        "targets": {"android"},
        "runners": {"ubuntu-24.04"},
        "recipes": {"android.py"},
        "action_calls": 1,
    },
    "onnxruntime-builder-apple.yml": {
        "targets": {
            "ios-static-xcframework",
            "osx-arm64-static_lib",
            "osx-x86_64-static_lib",
        },
        "runners": {"macos-15", "macos-15-intel"},
        "recipes": {"apple_xcframework.py", "macos_static.py"},
        "action_calls": 2,
    },
    "onnxruntime-builder-linux.yml": {
        "targets": {"linux-x64-glibc2_17", "linux-aarch64-glibc2_17"},
        "runners": {"ubuntu-24.04", "ubuntu-24.04-arm"},
        "recipes": {"linux_native.py"},
        "action_calls": 2,
    },
    "onnxruntime-builder-windows.yml": {
        "targets": {"win-x64-static_lib-mt"},
        "runners": {"windows-2022"},
        "recipes": {"windows_cpu.py"},
        "action_calls": 1,
    },
    "onnxruntime-builder-wasm.yml": {
        "targets": {"wasm-static_lib-simd"},
        "runners": {"ubuntu-24.04"},
        "recipes": {"wasm.py"},
        "action_calls": 1,
    },
}


class WorkflowTopologyTest(unittest.TestCase):
    def test_builder_workflows_are_split_by_contract_and_platform_family(self) -> None:
        actual = {path.name for path in WORKFLOWS.glob("onnxruntime-builder-*.yml")}
        self.assertEqual(actual, {"onnxruntime-builder-contracts.yml", *FAMILIES})
        self.assertNotIn("onnxruntime-builder-ci.yml", actual)
        self.assertNotIn("onnxruntime-builder-manual.yml", actual)

    def test_family_dispatches_have_fixed_targets_and_runners(self) -> None:
        all_targets: list[str] = []
        for name, expected in FAMILIES.items():
            with self.subTest(workflow=name):
                text = (WORKFLOWS / name).read_text(encoding="utf-8")
                self.assertIn("  workflow_dispatch:\n", text)
                self.assertNotIn("inputs:", text)
                self.assertNotIn("fromJSON", text)
                self.assertNotIn("source_ref", text)
                self.assertNotIn("--source-ref", text)
                self.assertNotIn("--version", text)
                self.assertNotRegex(text, r"runs-on:\s*\$\{\{")

                targets = set(
                    re.findall(
                        r"^\s+(?:-\s+)?target:\s+([a-z0-9][a-z0-9_-]+)\s*$",
                        text,
                        re.MULTILINE,
                    )
                )
                runners = set(
                    re.findall(
                        r"^\s+runs-on:\s+([a-zA-Z0-9_.-]+)\s*$",
                        text,
                        re.MULTILINE,
                    )
                )
                self.assertEqual(targets, expected["targets"])
                self.assertEqual(runners, expected["runners"])
                for recipe in expected["recipes"]:
                    self.assertIn(f"recipes/{recipe}", text)
                self.assertEqual(
                    text.count("uses: ./.github/actions/onnxruntime-artifact"),
                    expected["action_calls"],
                )
                all_targets.extend(targets)

        self.assertEqual(len(all_targets), len(set(all_targets)))
        self.assertEqual(set(all_targets), EXPECTED_AUTOMATIC_TARGETS)

    def test_workflows_are_read_only_and_remote_actions_are_immutable(self) -> None:
        workflow_paths = [WORKFLOWS / "onnxruntime-builder-contracts.yml"] + [
            WORKFLOWS / name for name in FAMILIES
        ]
        for path in [*workflow_paths, ARTIFACT_ACTION]:
            with self.subTest(path=path.name):
                text = path.read_text(encoding="utf-8")
                if path in workflow_paths:
                    self.assertIn("permissions:\n  contents: read", text)
                    self.assertNotIn("id-token: write", text)
                self.assertNotIn("publish", text.lower())
                for line in text.splitlines():
                    if "uses:" not in line or "uses: ./" in line:
                        continue
                    reference = line.split("uses:", 1)[1].strip().split()[0]
                    self.assertRegex(reference, r"^[^@]+@[0-9a-f]{40}$")

    def test_shared_action_builds_revalidates_and_briefly_retains_archives(self) -> None:
        text = ARTIFACT_ACTION.read_text(encoding="utf-8")
        self.assertEqual(
            text.count(
                "builder=(python -I -B tools/onnxruntime-build/onnxruntime-build)"
            ),
            2,
        )
        self.assertEqual(
            text.count(
                "builder=(python -I -B tools/onnxruntime-build/ci/run_target.py)"
            ),
            2,
        )
        self.assertIn('"${builder[@]}" build', text)
        self.assertIn('"${builder[@]}" validate', text)
        self.assertIn(
            "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
            text,
        )
        self.assertIn("retention-days: 3", text)
        self.assertIn("if-no-files-found: error", text)
        self.assertIn("include-hidden-files: true", text)
        self.assertLess(
            text.index('"${builder[@]}" validate'),
            text.index("actions/upload-artifact@"),
        )
        self.assertNotIn("validate_wasm_consumer", text)
        self.assertNotIn("WFLOAT_ONNXRUNTIME_WASM", text)

    def test_family_path_filters_are_local(self) -> None:
        contracts = (WORKFLOWS / "onnxruntime-builder-contracts.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('\"tools/onnxruntime-build/**\"', contracts)
        self.assertIn('\".github/workflows/onnxruntime-builder-*.yml\"', contracts)
        self.assertIn('\".github/actions/onnxruntime-artifact/**\"', contracts)

        validator = "tools/onnxruntime-build/onnxruntime_build/validate.py"
        unrelated_recipe = (
            "tools/onnxruntime-build/onnxruntime_build/recipes/directml.py"
        )
        for name, expected in FAMILIES.items():
            with self.subTest(workflow=name):
                family = (WORKFLOWS / name).read_text(encoding="utf-8")
                self.assertEqual(
                    family.count(
                        '\"tools/onnxruntime-build/onnxruntime_build/**\"'
                    ),
                    2,
                )
                self.assertEqual(
                    family.count(
                        '\"!tools/onnxruntime-build/onnxruntime_build/recipes/**\"'
                    ),
                    2,
                )
                self.assertEqual(
                    family.count('\".github/actions/onnxruntime-artifact/**\"'),
                    2,
                )
                self.assertTrue(_workflow_selects(family, validator))
                for recipe in expected["recipes"]:
                    recipe_path = (
                        "tools/onnxruntime-build/onnxruntime_build/recipes/"
                        + recipe
                    )
                    self.assertTrue(_workflow_selects(family, recipe_path))
                if "directml.py" not in expected["recipes"]:
                    self.assertFalse(_workflow_selects(family, unrelated_recipe))

        wasm = (WORKFLOWS / "onnxruntime-builder-wasm.yml").read_text(encoding="utf-8")
        downstream_consumer_inputs = [
            "vendor/sherpa-onnx/wasm/speech/CMakeLists.txt",
            "vendor/llama.cpp/src/llama.cpp",
            "scripts/ensure-emscripten.sh",
            "packages/wfloat-web/scripts/build-sherpa-speech-wasm.sh",
            "packages/wfloat-web/src/worker/worker.ts",
        ]
        for consumer_input in downstream_consumer_inputs:
            with self.subTest(consumer_input=consumer_input):
                self.assertFalse(_workflow_selects(wasm, consumer_input))
        self.assertNotIn("actions/setup-node@", wasm)
        self.assertNotIn("npm ci", wasm)

        linux = (WORKFLOWS / "onnxruntime-builder-linux.yml").read_text(encoding="utf-8")
        self.assertIn('\"tools/onnxruntime-build/ci/run_target.py\"', linux)
        self.assertIn('\"tools/onnxruntime-build/ci/install_gcc.py\"', linux)
        self.assertEqual(linux.count('manylinux: "true"'), 2)

    def test_android_workflow_installs_the_cataloged_toolchain(self) -> None:
        android = (WORKFLOWS / "onnxruntime-builder-android.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('sdkmanager "platforms;android-35" "ndk;28.0.13004108"', android)
        self.assertIn('java-version: "17"', android)

    def test_windows_workflow_selects_vs2022_and_proves_dumpbin(self) -> None:
        windows = (WORKFLOWS / "onnxruntime-builder-windows.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
            windows,
        )
        self.assertIn('vsversion: "2022"', windows)
        self.assertIn("arch: x64", windows)
        self.assertIn("Get-Command dumpbin.exe -ErrorAction Stop", windows)

    def test_apple_workflow_selects_the_cataloged_xcode_on_both_runners(self) -> None:
        apple = (WORKFLOWS / "onnxruntime-builder-apple.yml").read_text(
            encoding="utf-8"
        )
        developer_dir = "/Applications/Xcode_16.4.app/Contents/Developer"
        self.assertIn(f"DEVELOPER_DIR: {developer_dir}", apple)
        self.assertEqual(apple.count("test -d \"${DEVELOPER_DIR}\""), 2)
        self.assertEqual(apple.count("Build version 16F6"), 2)
        self.assertEqual(apple.count('echo "DEVELOPER_DIR=${DEVELOPER_DIR}"'), 2)

    def test_all_ci_execution_paths_are_part_of_builder_identity(self) -> None:
        build_source = (ROOT / "onnxruntime_build" / "build.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('".github/actions/onnxruntime-artifact"', build_source)
        for name in ["onnxruntime-builder-contracts.yml", *FAMILIES]:
            self.assertIn(f".github/workflows/{name}", build_source)


class CiRunnerTest(unittest.TestCase):
    def test_clean_guard_covers_ci_and_rejects_a_dirty_installer(self) -> None:
        completed = subprocess.CompletedProcess(
            ["git", "status"],
            0,
            stdout=" M tools/onnxruntime-build/ci/install_gcc.py\n",
        )
        with mock.patch.object(
            RUNNER.subprocess, "run", return_value=completed
        ) as run, self.assertRaisesRegex(RuntimeError, "before installing GCC"):
            RUNNER._require_clean_executable_paths()

        checked_paths = run.call_args.args[0]
        self.assertIn("tools/onnxruntime-build/ci", checked_paths)
        self.assertIn("tools/onnxruntime-build/onnxruntime_build", checked_paths)

    def test_dirty_installer_is_rejected_before_container_execution(self) -> None:
        with (
            mock.patch.object(
                RUNNER,
                "_require_clean_executable_paths",
                side_effect=RuntimeError(
                    "dirty, untracked, or ignored files are present in executable builder paths"
                ),
            ) as clean,
            mock.patch.object(RUNNER, "command_for") as command_for,
            mock.patch.object(RUNNER.subprocess, "run") as run,
            mock.patch("builtins.print") as printed,
        ):
            result = RUNNER.main(["build", "linux-x64-glibc2_17", "--jobs", "4"])

        self.assertEqual(result, 2)
        clean.assert_called_once_with()
        command_for.assert_not_called()
        run.assert_not_called()
        self.assertIn("dirty, untracked, or ignored", str(printed.call_args))

    def test_manylinux_wrapper_matches_the_cataloged_toolchain(self) -> None:
        catalog = Catalog.load()
        for target_id, image in RUNNER.MANYLINUX_IMAGES.items():
            with self.subTest(target=target_id):
                toolchain = catalog.target(target_id)["toolchain"]
                self.assertEqual(image, toolchain["container_image"])
                self.assertEqual(
                    GCC_INSTALLER.GCC_VERSION,
                    toolchain["compiler_version"],
                )
                self.assertEqual(
                    GCC_INSTALLER.GCC_SOURCE_URL,
                    toolchain["compiler_source"],
                )
                self.assertEqual(
                    GCC_INSTALLER.GCC_SOURCE_SHA512,
                    toolchain["compiler_source_sha512"],
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
        self.assertIn("@sha256:", RUNNER.MANYLINUX_IMAGES["linux-aarch64-glibc2_17"])
        self.assertIn("--user", x64)
        self.assertIn("--user", arm64)
        self.assertIn("501:20", x64)
        self.assertIn("501:20", arm64)
        self.assertIn("tools/onnxruntime-build/ci/install_gcc.py", x64[-1])
        self.assertIn(GCC_INSTALLER.GCC_VERSION, x64[-1])
        self.assertNotIn("setpriv", x64[-1])
        self.assertIn(f"CC={RUNNER.GCC_PREFIX}/bin/gcc", x64[-1])
        self.assertIn(f"CXX={RUNNER.GCC_PREFIX}/bin/g++", x64[-1])
        self.assertIn(f"LD_LIBRARY_PATH={RUNNER.GCC_PREFIX}/lib64", x64[-1])
        self.assertNotIn("/opt/clang", x64[-1])
        self.assertNotIn("-fuse-ld=lld", x64[-1])

    def test_other_targets_use_the_public_launcher_with_current_python(self) -> None:
        command = RUNNER.command_for(["build", "win-x64-static_lib-mt"])
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(command[1:3], ["-I", "-B"])
        self.assertEqual(command[3], str(ROOT / "onnxruntime-build"))
        self.assertEqual(command[-2:], ["build", "win-x64-static_lib-mt"])


if __name__ == "__main__":
    unittest.main()

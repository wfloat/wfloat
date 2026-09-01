from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from onnxruntime_build.build import (
    BuildError,
    _android_sdk_paths,
    _apple_settings,
    _base_build_command,
    build_target,
)
from onnxruntime_build.catalog import Catalog
from onnxruntime_build.core import BuildContext, CommandPlan
from onnxruntime_build.recipes.linux_native import plan as linux_native_plan
from onnxruntime_build.recipes.macos_static import plan as macos_static_plan


PINNED_COMMIT = "2e2543fbe9fae542f921d47a72d21d5a4ef0b710"


class BuildTest(unittest.TestCase):
    def test_microsoft_builds_accept_current_cmake_policy_handling(self) -> None:
        compatibility = "--cmake_extra_defines=CMAKE_POLICY_VERSION_MINIMUM=3.5"
        command = _base_build_command(Path("/source"), Path("/build"), jobs=2)
        self.assertIn(compatibility, command)

        target = Catalog.load().target("ios-static-xcframework")
        base = _apple_settings(target, jobs=2, run_tests=False)["build_params"]["base"]
        self.assertIn(compatibility, base)

    def test_apple_builds_disable_telemetry(self) -> None:
        target = Catalog.load().target("ios-static-xcframework")
        base = _apple_settings(target, jobs=2, run_tests=False)["build_params"]["base"]
        self.assertIn("--no_telemetry", base)
        self.assertIn("--compile_no_warning_as_error", base)

    def test_macos_static_build_settings_disable_microsoft_unit_tests(self) -> None:
        target = Catalog.load().target("osx-arm64-static_lib")
        with tempfile.TemporaryDirectory() as temporary_name:
            build_root = Path(temporary_name)
            context = BuildContext(Path("/source"), build_root, 2, False, False)
            macos_static_plan(target, context)
            settings = json.loads(
                (build_root / "apple-build-settings.json").read_text(encoding="utf-8")
            )

        base = settings["build_params"]["base"]
        self.assertIn("--skip_tests", base)
        self.assertIn("--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF", base)

    def test_glibc_2_17_build_disables_microsoft_unit_test_targets(self) -> None:
        target = Catalog.load().target("linux-x64-glibc2_17")
        context = BuildContext(Path("/source"), Path("/build"), 2, False, False)
        command = linux_native_plan(target, context).commands[0]
        self.assertIn("--skip_tests", command)
        self.assertIn(
            "--cmake_extra_defines=onnxruntime_BUILD_UNIT_TESTS=OFF", command
        )

    def test_android_ndk_environment_must_match_cataloged_revision(self) -> None:
        target = Catalog.load().target("android")
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            sdk = temporary / "sdk"
            ndk = sdk / "ndk" / "wrong"
            ndk.mkdir(parents=True)
            (ndk / "source.properties").write_text(
                "Pkg.Revision = 26.1.10909125\n", encoding="utf-8"
            )
            with mock.patch.dict(
                "os.environ",
                {"ANDROID_HOME": str(sdk), "ANDROID_NDK_HOME": str(ndk)},
                clear=True,
            ), self.assertRaisesRegex(BuildError, "requires Android NDK 28.0.13004108"):
                _android_sdk_paths(target)

    def test_build_prints_validation_before_archive_identity(self) -> None:
        catalog = Catalog.load()
        recipe = mock.Mock(name="wasm_recipe")
        recipe.name = "wasm"
        recipe.preflight = None
        recipe.plan.return_value = CommandPlan({}, [])
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            source = temporary / "source"
            source.mkdir()
            archive = temporary / "onnxruntime-wasm-static_lib-simd-1.29.0-0123456789ab.zip"
            output = io.StringIO()
            with mock.patch(
                "onnxruntime_build.build._builder_revision",
                return_value=(temporary, "0123456789ab"),
            ), mock.patch.object(
                catalog, "recipe", return_value=recipe
            ), mock.patch(
                "onnxruntime_build.build.acquire_source", return_value=(source, PINNED_COMMIT)
            ), mock.patch("onnxruntime_build.build.common_preflight"), mock.patch(
                "onnxruntime_build.build.run"
            ), mock.patch(
                "onnxruntime_build.build.verify_microsoft_source_after_build",
                return_value=PINNED_COMMIT,
            ), mock.patch(
                "onnxruntime_build.build.package_target", return_value=archive
            ), mock.patch(
                "onnxruntime_build.validate.validate_archive",
                return_value=["PASS package contract", "PASS compile/link smoke"],
            ), mock.patch(
                "onnxruntime_build.build.sha256", return_value="f" * 64
            ), redirect_stdout(output):
                build_target(
                    catalog=catalog,
                    target_id="wasm-static_lib-simd",
                    version="1.29.0",
                    jobs=2,
                    cache_dir=temporary / "cache",
                    work_dir=temporary / "build",
                    output_dir=temporary / "out",
                    source_dir=source,
                )

        lines = output.getvalue().splitlines()
        archive_index = next(
            index for index, line in enumerate(lines) if line.startswith("Archive:")
        )
        sha_index = next(
            index for index, line in enumerate(lines) if line.startswith("SHA-256:")
        )
        self.assertLess(lines.index("PASS package contract"), archive_index)
        self.assertLess(lines.index("PASS compile/link smoke"), sha_index)


if __name__ == "__main__":
    unittest.main()

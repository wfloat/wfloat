from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from onnxruntime_builder.build import (
    BuildError,
    _android_sdk_paths,
    _apple_settings,
    build_target,
)
from onnxruntime_builder.catalog import Catalog


PINNED_COMMIT = "2e2543fbe9fae542f921d47a72d21d5a4ef0b710"


class BuildTest(unittest.TestCase):
    def test_apple_builds_disable_telemetry(self) -> None:
        target = Catalog.load().target("ios-static-xcframework")
        base = _apple_settings(target, jobs=2, run_tests=False)["build_params"]["base"]
        self.assertIn("--no_telemetry", base)
        self.assertIn("--compile_no_warning_as_error", base)

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
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            source = temporary / "source"
            source.mkdir()
            archive = temporary / "onnxruntime-wasm-static_lib-simd-1.29.0-0123456789ab.zip"
            output = io.StringIO()
            with mock.patch(
                "onnxruntime_builder.build._builder_revision",
                return_value=(temporary, "0123456789ab"),
            ), mock.patch(
                "onnxruntime_builder.build.acquire_source", return_value=(source, PINNED_COMMIT)
            ), mock.patch("onnxruntime_builder.build._preflight"), mock.patch(
                "onnxruntime_builder.build._commands_for_target", return_value=({}, [])
            ), mock.patch(
                "onnxruntime_builder.build.package_target", return_value=archive
            ), mock.patch(
                "onnxruntime_builder.validate.validate_archive",
                return_value=["PASS package contract", "PASS compile/link smoke"],
            ), mock.patch(
                "onnxruntime_builder.build.sha256", return_value="f" * 64
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

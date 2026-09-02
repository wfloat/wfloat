from __future__ import annotations

import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from onnxruntime_build.package import (
    PackageError,
    _copy_standard_libraries,
    _copy_toolchain_runtime_notices,
    _zip_tree,
)


class PackagingTest(unittest.TestCase):
    def test_zip_tree_deflates_regular_file_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            root = temporary / "onnxruntime-fixture"
            root.mkdir()
            contents = b"compressible fixture\n" * 1024
            (root / "library.a").write_bytes(contents)
            archive = temporary / "onnxruntime-fixture.zip"

            _zip_tree(root, archive)

            with zipfile.ZipFile(archive) as package:
                member = package.getinfo("onnxruntime-fixture/library.a")
                self.assertEqual(member.compress_type, zipfile.ZIP_DEFLATED)
                self.assertLess(member.compress_size, member.file_size)
                self.assertEqual(package.read(member), contents)

    def test_static_toolchain_runtime_notices_are_copied(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            source = temporary / "toolchain-licenses"
            source.mkdir()
            names = ["GCC-COPYING3", "GCC-COPYING.RUNTIME", "libstdc++-NOTICES"]
            for name in names:
                (source / name).write_text(f"{name}\n", encoding="utf-8")
            expected_hashes = {
                name: hashlib.sha256(f"{name}\n".encode()).hexdigest()
                for name in names
            }

            destination = temporary / "package"
            _copy_toolchain_runtime_notices(
                {
                    "toolchain": {
                        "runtime_license_dir": str(source),
                        "runtime_license_files": names,
                        "runtime_license_sha256": expected_hashes,
                    }
                },
                destination,
            )

            for name in names:
                self.assertEqual(
                    (destination / "licenses" / name).read_text(encoding="utf-8"),
                    f"{name}\n",
                )

    def test_macos_static_package_dereferences_versioned_framework_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            framework = (
                temporary
                / "build/Release/framework_out/onnxruntime.framework"
            )
            binary = framework / "Versions/A/onnxruntime"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"!<arch>\nmonolithic archive")
            (framework / "Versions/Current").symlink_to("A", target_is_directory=True)
            (framework / "onnxruntime").symlink_to("Versions/Current/onnxruntime")

            destination = temporary / "package"
            _copy_standard_libraries(
                {"platform": "macos", "linkage": "static"},
                [temporary / "build"],
                destination,
            )

            packaged = destination / "lib/libonnxruntime.a"
            self.assertTrue(packaged.is_file())
            self.assertFalse(packaged.is_symlink())
            self.assertEqual(packaged.read_bytes(), binary.read_bytes())

    def test_macos_static_package_rejects_framework_binary_that_escapes_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            framework = temporary / "build/Release/onnxruntime.framework"
            framework.mkdir(parents=True)
            external = temporary / "external-onnxruntime"
            external.write_bytes(b"!<arch>\noutside")
            (framework / "onnxruntime").symlink_to(external)

            with self.assertRaisesRegex(PackageError, "outside its framework"):
                _copy_standard_libraries(
                    {"platform": "macos", "linkage": "static"},
                    [temporary / "build"],
                    temporary / "package",
                )


if __name__ == "__main__":
    unittest.main()

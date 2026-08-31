from __future__ import annotations

import stat
import tempfile
import unittest
import zipfile
import plistlib
from pathlib import Path
from unittest import mock

from onnxruntime_build.catalog import Catalog
from onnxruntime_build.validate import (
    ValidationError,
    _android_readelf,
    _architecture_matches,
    _check_apple_minimum,
    _object_archive_members,
    _smoke_test,
    validate_archive,
)


BUILDER = "0123456789ab"


def _write_member(archive: zipfile.ZipFile, name: str, data: bytes = b"fixture\n") -> None:
    archive.writestr(name, data)


def _standard_fixture(path: Path, target: dict, *, notice: bool = True, extra_top: bool = False) -> None:
    top = path.stem
    with zipfile.ZipFile(path, "w") as archive:
        _write_member(archive, f"{top}/LICENSE")
        if notice:
            _write_member(archive, f"{top}/ThirdPartyNotices.txt")
        headers = target["package"]["headers_dir"]
        _write_member(archive, f"{top}/{headers}/onnxruntime_c_api.h")
        _write_member(archive, f"{top}/{headers}/onnxruntime_cxx_api.h")
        for library in target["package"]["required_libraries"]:
            _write_member(archive, f"{top}/{library}")
        if extra_top:
            _write_member(archive, "other/file")


class PackageContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = Catalog.load()

    def test_valid_standard_contract(self) -> None:
        target = self.catalog.target("linux-x64-glibc2_17")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-linux-x64-glibc2_17-1.29.0-{BUILDER}.zip"
            _standard_fixture(archive, target)
            messages = validate_archive(
                self.catalog,
                target["id"],
                archive,
                run_smoke=False,
                inspect_metadata=False,
            )
        self.assertEqual(len(messages), 3)
        self.assertTrue(messages[0].startswith("PASS"))

    def test_android_readelf_is_discovered_inside_selected_ndk(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            ndk = Path(temporary_name) / "ndk"
            readelf = ndk / "toolchains/llvm/prebuilt/test-host/bin/llvm-readelf"
            readelf.parent.mkdir(parents=True)
            readelf.write_text("fixture\n", encoding="utf-8")
            readelf.chmod(0o755)
            with mock.patch.dict(
                "os.environ", {"ANDROID_NDK_HOME": str(ndk)}, clear=True
            ), mock.patch("onnxruntime_build.validate.shutil.which", return_value=None):
                self.assertEqual(_android_readelf("28.0.13004108"), str(readelf))

    def test_apple_minimum_validation_is_architecture_specific(self) -> None:
        reported = {"arm64": ["14.0"], "x86_64": ["13.0"]}
        with mock.patch(
            "onnxruntime_build.validate._apple_minimum_versions_by_architecture",
            return_value=reported,
        ):
            _check_apple_minimum(
                Path("simulator.a"),
                "13.0",
                ["arm64", "x86_64"],
                {"arm64": "14.0"},
            )
            with self.assertRaisesRegex(ValidationError, "arm64"):
                _check_apple_minimum(
                    Path("simulator.a"),
                    "13.0",
                    ["arm64", "x86_64"],
                )

    def test_missing_notice_is_rejected(self) -> None:
        target = self.catalog.target("wasm-static_lib-simd")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-wasm-static_lib-simd-1.29.0-{BUILDER}.zip"
            _standard_fixture(archive, target, notice=False)
            with self.assertRaisesRegex(ValidationError, "ThirdPartyNotices"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_multiple_top_level_directories_are_rejected(self) -> None:
        target = self.catalog.target("linux-x64-glibc2_28")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-linux-x64-glibc2_28-1.29.0-{BUILDER}.zip"
            _standard_fixture(archive, target, extra_top=True)
            with self.assertRaisesRegex(ValidationError, "exactly top-level"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_path_traversal_is_rejected(self) -> None:
        target = self.catalog.target("linux-x64-static_lib-glibc2_17")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-linux-x64-static_lib-glibc2_17-1.29.0-{BUILDER}.zip"
            with zipfile.ZipFile(archive, "w") as output:
                _write_member(output, f"{archive.stem}/../escape")
            with self.assertRaisesRegex(ValidationError, "unsafe archive member"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_duplicate_zip_member_name_is_rejected(self) -> None:
        target = self.catalog.target("wasm-static_lib-simd")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-wasm-static_lib-simd-1.29.0-{BUILDER}.zip"
            duplicate = f"{archive.stem}/LICENSE"
            with self.assertWarns(UserWarning), zipfile.ZipFile(archive, "w") as output:
                _write_member(output, duplicate, b"first")
                _write_member(output, duplicate, b"second")
            with self.assertRaisesRegex(ValidationError, "duplicate member name"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_escaping_symlink_is_rejected(self) -> None:
        target = self.catalog.target("osx-arm64")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-osx-arm64-1.29.0-{BUILDER}.zip"
            with zipfile.ZipFile(archive, "w") as output:
                info = zipfile.ZipInfo(f"{archive.stem}/lib/libonnxruntime.dylib")
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                output.writestr(info, "../../../escape")
            with self.assertRaisesRegex(ValidationError, "symlink escapes"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_android_requires_all_four_abis(self) -> None:
        target = self.catalog.target("android")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-android-1.29.0-{BUILDER}.zip"
            top = archive.stem
            with zipfile.ZipFile(archive, "w") as output:
                _write_member(output, f"{top}/LICENSE")
                _write_member(output, f"{top}/ThirdPartyNotices.txt")
                _write_member(output, f"{top}/headers/onnxruntime_c_api.h")
                _write_member(output, f"{top}/headers/onnxruntime_cxx_api.h")
                for abi in target["architectures"][:-1]:
                    _write_member(output, f"{top}/jni/{abi}/libonnxruntime.so")
            with self.assertRaisesRegex(ValidationError, target["architectures"][-1]):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_xcframework_slice_contract(self) -> None:
        target = self.catalog.target("ios-static-xcframework")
        entries = [
            {
                "LibraryIdentifier": "ios-arm64",
                "LibraryPath": "onnxruntime.framework",
                "SupportedArchitectures": ["arm64"],
                "SupportedPlatform": "ios",
            },
            {
                "LibraryIdentifier": "ios-arm64_x86_64-simulator",
                "LibraryPath": "onnxruntime.framework",
                "SupportedArchitectures": ["arm64", "x86_64"],
                "SupportedPlatform": "ios",
                "SupportedPlatformVariant": "simulator",
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / f"onnxruntime-ios-static-xcframework-1.29.0-{BUILDER}.zip"
            top = archive.stem
            bundle = f"{top}/onnxruntime.xcframework"
            with zipfile.ZipFile(archive, "w") as output:
                _write_member(output, f"{top}/LICENSE")
                _write_member(output, f"{top}/ThirdPartyNotices.txt")
                _write_member(output, f"{bundle}/Info.plist", plistlib.dumps({"AvailableLibraries": entries}))
                for entry in entries:
                    framework = f"{bundle}/{entry['LibraryIdentifier']}/onnxruntime.framework"
                    _write_member(output, f"{framework}/onnxruntime")
                    _write_member(output, f"{framework}/Headers/onnxruntime_c_api.h")
                    _write_member(output, f"{framework}/Headers/onnxruntime_cxx_api.h")
            messages = validate_archive(
                self.catalog,
                target["id"],
                archive,
                run_smoke=False,
                inspect_metadata=False,
            )
        self.assertEqual(len(messages), 3)

    def test_filename_builder_must_be_lowercase_twelve_hex(self) -> None:
        target = self.catalog.target("wasm-static_lib")
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "onnxruntime-wasm-static_lib-1.29.0-NOTACOMMIT12.zip"
            _standard_fixture(archive, target)
            with self.assertRaisesRegex(ValidationError, "12 lowercase hexadecimal"):
                validate_archive(
                    self.catalog, target["id"], archive, run_smoke=False, inspect_metadata=False
                )

    def test_validation_source_checkout_must_match_archive_version_pin(self) -> None:
        target = self.catalog.target("wasm-static_lib")
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            archive = temporary / f"onnxruntime-wasm-static_lib-1.29.0-{BUILDER}.zip"
            _standard_fixture(archive, target)
            with mock.patch(
                "onnxruntime_build.validate.verify_microsoft_source", return_value="b" * 40
            ), self.assertRaisesRegex(ValidationError, "not cataloged commit"):
                validate_archive(
                    self.catalog,
                    target["id"],
                    archive,
                    run_smoke=False,
                    inspect_metadata=False,
                    source_dir=temporary / "source",
                )

    def test_wasm_metadata_rejects_llvm_bitcode(self) -> None:
        self.assertFalse(_architecture_matches("wasm32", "LLVM IR bitcode"))
        self.assertTrue(_architecture_matches("wasm32", "WebAssembly (wasm) binary module"))

    def test_archive_symbol_tables_are_not_selected_as_objects(self) -> None:
        members = ["/", "//", "runtime.cc.o/", "/0", "provider.obj", "module.bc"]
        self.assertEqual(
            _object_archive_members(members),
            ["runtime.cc.o/", "provider.obj", "module.bc"],
        )

    def test_wasm_smoke_cross_compiles_instead_of_skipping_for_host_architecture(self) -> None:
        target = self.catalog.target("wasm-static_lib-simd")
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            root = temporary / "package"
            (root / "include").mkdir(parents=True)
            (root / "lib").mkdir()
            (root / "lib" / "libonnxruntime.a").write_bytes(b"archive")
            source_dir = temporary / "source"
            compiler = source_dir / "cmake/external/emsdk/upstream/emscripten/em++"
            compiler.parent.mkdir(parents=True)
            compiler.write_text("fixture\n", encoding="utf-8")

            def fake_tool(command: list[str]) -> str:
                self.assertNotIn("-sDISABLE_EXCEPTION_CATCHING=0", command)
                output = Path(command[command.index("-o") + 1])
                output.write_bytes(b"\x00asm")
                return ""

            with mock.patch("onnxruntime_build.validate.shutil.which", return_value=None), mock.patch(
                "onnxruntime_build.validate._tool_output", side_effect=fake_tool
            ):
                result = _smoke_test(target, root, source_dir)
        self.assertEqual(result, "PASS compile/link smoke (WebAssembly final link)")


if __name__ == "__main__":
    unittest.main()

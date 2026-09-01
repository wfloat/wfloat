from __future__ import annotations

import hashlib
import importlib.util
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "install_gnu_toolchain", ROOT / "ci" / "install_gnu_toolchain.py"
)
assert SPEC and SPEC.loader
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class GnuToolchainInstallerTest(unittest.TestCase):
    def test_source_identities_are_official_and_sha512_pinned(self) -> None:
        gcc_source = urlparse(INSTALLER.GCC_SOURCE_URL)
        binutils_source = urlparse(INSTALLER.BINUTILS_SOURCE_URL)
        self.assertEqual((gcc_source.scheme, gcc_source.hostname), ("https", "gcc.gnu.org"))
        self.assertEqual(
            (binutils_source.scheme, binutils_source.hostname),
            ("https", "ftp.gnu.org"),
        )
        for checksum in (
            INSTALLER.GCC_SOURCE_SHA512,
            INSTALLER.BINUTILS_SOURCE_SHA512,
        ):
            self.assertEqual(len(checksum), 128)
            self.assertTrue(
                all(character in "0123456789abcdef" for character in checksum)
            )
        self.assertEqual(
            INSTALLER.DEFAULT_PREFIX,
            Path("/tmp/wfloat-gnu-toolchain-gcc-11.4.0-binutils-2.42"),
        )
        self.assertEqual(
            set(INSTALLER.EXPECTED_TOOL_VERSIONS),
            {
                "gcc",
                "g++",
                "as",
                "ld",
                "ar",
                "nm",
                "ranlib",
                "strip",
                "objdump",
                "readelf",
                "gcc-ar",
                "gcc-nm",
                "gcc-ranlib",
            },
        )

    def test_installed_version_check_covers_every_consumed_tool(self) -> None:
        names = INSTALLER.EXPECTED_TOOL_VERSIONS
        binutils_program = {
            "as": "assembler",
            "gcc-ar": "ar",
            "gcc-nm": "nm",
            "gcc-ranlib": "ranlib",
        }

        def completed(command: list[Path | str], **_kwargs) -> subprocess.CompletedProcess:
            name = Path(command[0]).name
            output = (
                INSTALLER.GCC_VERSION
                if name in {"gcc", "g++"}
                else f"GNU {binutils_program.get(name, name)} (GNU Binutils) "
                f"{INSTALLER.BINUTILS_VERSION}\n"
            )
            return subprocess.CompletedProcess(command, 0, stdout=output)

        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name)
            tool_dir = prefix / "bin"
            tool_dir.mkdir()
            for name in names:
                (tool_dir / name).touch()
            with mock.patch.object(
                INSTALLER.subprocess, "run", side_effect=completed
            ):
                self.assertEqual(INSTALLER._installed_versions(prefix), names)
                (tool_dir / "gcc-ranlib").unlink()
                self.assertIsNone(INSTALLER._installed_versions(prefix))

    def test_download_accepts_only_the_expected_sha512(self) -> None:
        payload = b"verified toolchain fixture"
        expected = hashlib.sha512(payload).hexdigest()
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            accepted = temporary / "accepted"
            with mock.patch.object(
                INSTALLER.urllib.request,
                "urlopen",
                return_value=io.BytesIO(payload),
            ):
                INSTALLER._download("https://gcc.gnu.org/fixture", accepted, expected)
            self.assertEqual(accepted.read_bytes(), payload)

            rejected = temporary / "rejected"
            with mock.patch.object(
                INSTALLER.urllib.request,
                "urlopen",
                return_value=io.BytesIO(payload),
            ), self.assertRaisesRegex(RuntimeError, "SHA-512 mismatch"):
                INSTALLER._download("https://gcc.gnu.org/fixture", rejected, "0" * 128)

    def test_prerequisite_checksums_must_come_from_verified_gcc_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            source = Path(temporary_name)
            (source / "contrib").mkdir()
            (source / "contrib" / "prerequisites.sha512").write_text(
                "0" * 128 + "  gmp-6.1.0.tar.bz2\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "lacks prerequisite checksums"):
                INSTALLER._prerequisite_hashes(source)

    def test_extract_rejects_a_member_that_escapes_the_verified_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            workspace = Path(temporary_name)
            archive_path = workspace / INSTALLER.GCC_ARCHIVE
            with tarfile.open(archive_path, "w:xz") as archive:
                member = tarfile.TarInfo(
                    f"gcc-{INSTALLER.GCC_VERSION}/../../outside"
                )
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            extract_root = workspace / "extract"
            extract_root.mkdir()
            with self.assertRaises(tarfile.FilterError):
                INSTALLER._extract_gcc(archive_path, extract_root)
            self.assertFalse((workspace / "outside").exists())

    def test_install_orchestration_keeps_the_bounded_gnu_toolchain_contract(self) -> None:
        prerequisite_hashes = {
            name: str(index) * 128
            for index, name in enumerate(INSTALLER.GCC_PREREQUISITES, start=1)
        }
        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name) / "gnu-toolchain"
            with (
                mock.patch.object(
                    INSTALLER,
                    "_installed_versions",
                    side_effect=[None, INSTALLER.EXPECTED_TOOL_VERSIONS],
                ),
                mock.patch.object(INSTALLER, "_download") as download,
                mock.patch.object(
                    INSTALLER,
                    "_extract_binutils",
                    return_value=Path("/verified/binutils-2.42"),
                ),
                mock.patch.object(
                    INSTALLER,
                    "_extract_gcc",
                    return_value=Path("/verified/gcc-11.4.0"),
                ),
                mock.patch.object(
                    INSTALLER,
                    "_prerequisite_hashes",
                    return_value=prerequisite_hashes,
                ),
                mock.patch.object(INSTALLER, "_run") as run,
            ):
                INSTALLER.install(prefix, 4)

        self.assertEqual(download.call_count, 2 + len(INSTALLER.GCC_PREREQUISITES))
        commands = [call.args[0] for call in run.call_args_list]
        binutils_configure = commands[0]
        self.assertIn("--disable-gdb", binutils_configure)
        self.assertIn("--disable-gold", binutils_configure)
        self.assertIn("--disable-gprofng", binutils_configure)
        self.assertIn("--disable-shared", binutils_configure)
        self.assertIn("--enable-deterministic-archives", binutils_configure)
        self.assertEqual(commands[1], ["make", "-j4", "MAKEINFO=/bin/true"])
        self.assertEqual(
            commands[2], ["make", "MAKEINFO=/bin/true", "install-strip"]
        )
        self.assertEqual(
            commands[3], ["./contrib/download_prerequisites", "--no-isl"]
        )
        gcc_configure = commands[4]
        self.assertIn("--enable-languages=c,c++", gcc_configure)
        self.assertIn("--disable-bootstrap", gcc_configure)
        self.assertIn("--disable-libsanitizer", gcc_configure)
        self.assertIn("--disable-multilib", gcc_configure)
        self.assertIn(f"--with-as={prefix / 'bin' / 'as'}", gcc_configure)
        self.assertIn(f"--with-ld={prefix / 'bin' / 'ld'}", gcc_configure)
        self.assertIn("--without-isl", gcc_configure)
        self.assertEqual(commands[5], ["make", "-j4"])
        self.assertEqual(commands[6], ["make", "install-strip"])

    def test_install_reuses_only_the_exact_existing_toolchain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name)
            with mock.patch.object(
                INSTALLER,
                "_installed_versions",
                return_value=INSTALLER.EXPECTED_TOOL_VERSIONS,
            ), mock.patch.object(INSTALLER, "_download") as download:
                INSTALLER.install(prefix, 4)
            download.assert_not_called()

            with mock.patch.object(
                INSTALLER, "_installed_versions", return_value=None
            ), self.assertRaisesRegex(RuntimeError, "partial or unexpected"):
                INSTALLER.install(prefix, 4)


if __name__ == "__main__":
    unittest.main()

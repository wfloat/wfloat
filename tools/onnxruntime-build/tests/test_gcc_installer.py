from __future__ import annotations

import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "install_gcc", ROOT / "ci" / "install_gcc.py"
)
assert SPEC and SPEC.loader
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class GccInstallerTest(unittest.TestCase):
    def test_gcc_source_identity_is_official_and_sha512_pinned(self) -> None:
        source = urlparse(INSTALLER.GCC_SOURCE_URL)
        self.assertEqual(source.scheme, "https")
        self.assertEqual(source.hostname, "gcc.gnu.org")
        self.assertEqual(len(INSTALLER.GCC_SOURCE_SHA512), 128)
        self.assertTrue(
            all(
                character in "0123456789abcdef"
                for character in INSTALLER.GCC_SOURCE_SHA512
            )
        )
        self.assertEqual(INSTALLER.DEFAULT_PREFIX, Path("/tmp/wfloat-gcc-11.4.0"))

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

    def test_install_orchestration_keeps_the_bounded_cxx_toolchain_contract(self) -> None:
        prerequisite_hashes = {
            name: str(index) * 128
            for index, name in enumerate(INSTALLER.GCC_PREREQUISITES, start=1)
        }
        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name) / "gcc"
            with (
                mock.patch.object(
                    INSTALLER, "_installed_version", side_effect=[None, "11.4.0"]
                ),
                mock.patch.object(INSTALLER, "_download") as download,
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

        self.assertEqual(download.call_count, 1 + len(INSTALLER.GCC_PREREQUISITES))
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(
            commands[0], ["./contrib/download_prerequisites", "--no-isl"]
        )
        configure = commands[1]
        self.assertIn("--enable-languages=c,c++", configure)
        self.assertIn("--disable-bootstrap", configure)
        self.assertIn("--disable-libsanitizer", configure)
        self.assertIn("--disable-multilib", configure)
        self.assertIn("--without-isl", configure)
        self.assertEqual(commands[2], ["make", "-j4"])
        self.assertEqual(commands[3], ["make", "install-strip"])

    def test_install_reuses_only_the_exact_existing_toolchain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            prefix = Path(temporary_name)
            with mock.patch.object(
                INSTALLER, "_installed_version", return_value="11.4.0"
            ), mock.patch.object(INSTALLER, "_download") as download:
                INSTALLER.install(prefix, 4)
            download.assert_not_called()

            with mock.patch.object(
                INSTALLER, "_installed_version", return_value=None
            ), self.assertRaisesRegex(RuntimeError, "partial or unexpected"):
                INSTALLER.install(prefix, 4)


if __name__ == "__main__":
    unittest.main()

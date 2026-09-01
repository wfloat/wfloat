from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
BOOTSTRAP = REPOSITORY / "scripts" / "ensure-emscripten.sh"
EMSDK_REVISION = "419021fa040428bc69ef1559b325addb8e10211f"


class EmscriptenBootstrapTest(unittest.TestCase):
    def git(self, repository: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(repository), *args],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()

    def make_managed_cache(
        self,
        temporary: Path,
        *,
        reported_version: str = "4.0.8",
    ) -> tuple[Path, Path, str]:
        source = temporary / "emsdk-origin"
        managed = temporary / "emsdk-cache"
        source.mkdir()
        self.git(source, "init", "--quiet")
        self.git(source, "config", "user.name", "Wfloat test")
        self.git(source, "config", "user.email", "test@wfloat.com")

        binary_dir = source / "bin"
        binary_dir.mkdir()
        emcc = binary_dir / "emcc"
        emcc.write_text(
            "#!/usr/bin/env bash\n"
            f"echo 'emcc (Emscripten gcc/clang-like replacement) {reported_version} (fixture)'\n",
            encoding="utf-8",
        )
        emcmake = binary_dir / "emcmake"
        emcmake.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        emsdk = source / "emsdk"
        emsdk.write_text(
            "#!/usr/bin/env bash\n"
            "echo 'unexpected emsdk invocation' >&2\n"
            "exit 91\n",
            encoding="utf-8",
        )
        for executable in [emcc, emcmake, emsdk]:
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        (source / "emsdk_env.sh").write_text(
            "fixture_dir=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
            "export PATH=\"${fixture_dir}/bin:${PATH}\"\n",
            encoding="utf-8",
        )
        self.git(source, "add", ".")
        self.git(source, "commit", "--quiet", "-m", "pinned fixture")
        revision = self.git(source, "rev-parse", "HEAD^{commit}")

        (source / "later.txt").write_text("mutable tip fixture\n", encoding="utf-8")
        self.git(source, "add", "later.txt")
        self.git(source, "commit", "--quiet", "-m", "later mutable tip")
        subprocess.run(
            ["git", "clone", "--quiet", str(source), str(managed)],
            check=True,
        )
        return source, managed, revision

    def run_bootstrap(
        self,
        source: Path,
        managed: Path,
        revision: str,
    ) -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        environment.update(
            {
                "WFLOAT_EMSCRIPTEN_VERSION": "4.0.8",
                "WFLOAT_EMSDK_REPO": str(source),
                "WFLOAT_EMSDK_REVISION": revision,
                "WFLOAT_EMSDK_DIR": str(managed),
            }
        )
        return subprocess.run(
            ["bash", str(BOOTSTRAP)],
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

    def test_managed_cache_checks_out_the_exact_revision_and_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, managed, revision = self.make_managed_cache(Path(temporary))
            self.assertNotEqual(self.git(managed, "rev-parse", "HEAD^{commit}"), revision)
            result = self.run_bootstrap(source, managed, revision)
            actual_revision = self.git(managed, "rev-parse", "HEAD^{commit}")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(actual_revision, revision)
        self.assertIn(f"Using Emscripten 4.0.8 from emsdk {revision}", result.stdout)

    def test_missing_managed_cache_is_cloned_then_pinned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, _, revision = self.make_managed_cache(directory)
            managed = directory / "fresh-managed-cache"
            result = self.run_bootstrap(source, managed, revision)
            actual_revision = self.git(managed, "rev-parse", "HEAD^{commit}")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(actual_revision, revision)

    def test_version_comparison_does_not_accept_a_longer_substring_match(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, managed, revision = self.make_managed_cache(
                Path(temporary),
                reported_version="4.0.80",
            )
            result = self.run_bootstrap(source, managed, revision)
        self.assertEqual(result.returncode, 91, result.stdout)
        self.assertIn("unexpected emsdk invocation", result.stdout)

    def test_modified_managed_cache_is_refused_without_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, managed, revision = self.make_managed_cache(Path(temporary))
            (managed / "user-file.txt").write_text("preserve me\n", encoding="utf-8")
            result = self.run_bootstrap(source, managed, revision)
            self.assertTrue((managed / "user-file.txt").is_file())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing modified Emscripten SDK cache", result.stdout)

    def test_default_evidence_pin_is_full_and_origin_is_checked(self) -> None:
        script = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn(f'WFLOAT_EMSDK_REVISION="${{WFLOAT_EMSDK_REVISION:-{EMSDK_REVISION}}}"', script)
        self.assertIn("remote get-url origin", script)
        self.assertIn("status --porcelain --untracked-files=normal", script)
        self.assertNotIn('grep -q "${WFLOAT_EMSCRIPTEN_VERSION}"', script)


if __name__ == "__main__":
    unittest.main()

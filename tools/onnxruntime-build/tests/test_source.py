from __future__ import annotations

import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest import mock

from onnxruntime_builder.source import (
    MICROSOFT_REPOSITORY,
    SourceError,
    _sanitize_managed_cache,
    acquire_source,
    verify_microsoft_source,
    verify_microsoft_source_after_build,
)


PINNED_COMMIT = "2e2543fbe9fae542f921d47a72d21d5a4ef0b710"


class SourceTest(unittest.TestCase):
    def _git(self, repository: Path, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=repository,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout.strip()

    def _repository(self, root: Path, name: str, *, microsoft_origin: bool = False) -> Path:
        repository = root / name
        repository.mkdir()
        self._git(repository, "init")
        self._git(repository, "config", "user.email", "builder-test@wfloat.com")
        self._git(repository, "config", "user.name", "Wfloat builder test")
        (repository / "tracked.txt").write_text("exact\n", encoding="utf-8")
        self._git(repository, "add", "tracked.txt")
        self._git(repository, "commit", "-m", "fixture")
        if microsoft_origin:
            self._git(repository, "remote", "add", "origin", MICROSOFT_REPOSITORY)
        return repository

    def test_existing_checkout_must_match_cataloged_revision_before_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            with mock.patch(
                "onnxruntime_builder.source.verify_microsoft_source", return_value="b" * 40
            ), mock.patch("onnxruntime_builder.source._run") as run:
                with self.assertRaisesRegex(SourceError, "not cataloged commit"):
                    acquire_source(
                        cache_dir=temporary / "cache",
                        version="1.29.0",
                        source_revision=PINNED_COMMIT,
                        jobs=2,
                        source_dir=temporary / "source",
                    )
        run.assert_not_called()

    def test_exact_source_rejects_tracked_and_untracked_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            repository = self._repository(
                Path(temporary_name), "source", microsoft_origin=True
            )
            expected = self._git(repository, "rev-parse", "HEAD")
            self.assertEqual(verify_microsoft_source(repository), expected)

            (repository / "tracked.txt").write_text("modified\n", encoding="utf-8")
            with self.assertRaisesRegex(SourceError, "must be clean"):
                verify_microsoft_source(repository)

    def test_exact_source_rejects_ignored_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            repository = self._repository(
                Path(temporary_name), "source", microsoft_origin=True
            )
            (repository / ".gitignore").write_text("generated/\n", encoding="utf-8")
            self._git(repository, "add", ".gitignore")
            self._git(repository, "commit", "-m", "ignore generated inputs")
            (repository / "generated").mkdir()
            (repository / "generated/tool.py").write_text(
                "print('modified tool')\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(SourceError, "must be clean"):
                verify_microsoft_source(repository)

            self._git(repository, "restore", "tracked.txt")
            (repository / "untracked.txt").write_text("untracked\n", encoding="utf-8")
            with self.assertRaisesRegex(SourceError, "must be clean"):
                verify_microsoft_source(repository)

    def test_exact_source_rejects_modified_submodule_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            child = self._repository(temporary, "child")
            source = self._repository(temporary, "source", microsoft_origin=True)
            self._git(
                source,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(child),
                "deps/child",
            )
            self._git(source, "commit", "-am", "add submodule")
            verify_microsoft_source(source)

            (source / "deps/child/tracked.txt").write_text("modified\n", encoding="utf-8")
            with self.assertRaisesRegex(SourceError, "must be clean|submodule contents"):
                verify_microsoft_source(source)

    def test_exact_source_rejects_ignored_submodule_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            temporary = Path(temporary_name)
            child = self._repository(temporary, "child")
            (child / ".gitignore").write_text("generated/\n", encoding="utf-8")
            self._git(child, "add", ".gitignore")
            self._git(child, "commit", "-m", "ignore generated inputs")
            source = self._repository(temporary, "source", microsoft_origin=True)
            self._git(
                source,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(child),
                "deps/child",
            )
            self._git(source, "commit", "-am", "add submodule")
            generated = source / "deps/child/generated"
            generated.mkdir()
            (generated / "compiler").write_text("modified\n", encoding="utf-8")

            with self.assertRaisesRegex(SourceError, "must be clean|submodule contents"):
                verify_microsoft_source(source)

    def test_builder_owned_cache_sanitizes_only_ignored_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            repository = self._repository(
                Path(temporary_name), "source", microsoft_origin=True
            )
            (repository / ".gitignore").write_text("generated/\n", encoding="utf-8")
            self._git(repository, "add", ".gitignore")
            self._git(repository, "commit", "-m", "ignore generated outputs")
            generated = repository / "generated"
            generated.mkdir()
            (generated / "tool").write_text("cached\n", encoding="utf-8")

            _sanitize_managed_cache(repository)

            self.assertFalse(generated.exists())
            self.assertEqual(
                (repository / "tracked.txt").read_text(encoding="utf-8"), "exact\n"
            )
            verify_microsoft_source(repository)

    def test_post_build_check_allows_only_ignored_generated_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_name:
            repository = self._repository(
                Path(temporary_name), "source", microsoft_origin=True
            )
            (repository / ".gitignore").write_text("generated/\n", encoding="utf-8")
            self._git(repository, "add", ".gitignore")
            self._git(repository, "commit", "-m", "ignore generated outputs")
            generated = repository / "generated"
            generated.mkdir()
            (generated / "tool").write_text("installed by build\n", encoding="utf-8")

            expected = self._git(repository, "rev-parse", "HEAD")
            self.assertEqual(verify_microsoft_source_after_build(repository), expected)

            (repository / "tracked.txt").write_text("modified by build\n", encoding="utf-8")
            with self.assertRaisesRegex(SourceError, "must be clean"):
                verify_microsoft_source_after_build(repository)


if __name__ == "__main__":
    unittest.main()

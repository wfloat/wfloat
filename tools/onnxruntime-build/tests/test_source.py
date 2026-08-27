from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from onnxruntime_builder.source import SourceError, acquire_source


PINNED_COMMIT = "2e2543fbe9fae542f921d47a72d21d5a4ef0b710"


class SourceTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

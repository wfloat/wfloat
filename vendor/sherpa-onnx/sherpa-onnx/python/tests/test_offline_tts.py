# sherpa-onnx/python/tests/test_offline_tts.py
#
# Copyright (c)  2026  Xiaomi Corporation
#
# To run this single test, use
#
#  ctest --verbose -R test_offline_tts_py

import unittest

import sherpa_onnx


class TestOfflineTts(unittest.TestCase):
    def test_wfloat_prepare_text(self):
        if sherpa_onnx.prepare_wfloat_text is None:
            print("TTS support is not enabled, skipping test_wfloat_prepare_text()")
            return

        self.assertIsNotNone(sherpa_onnx.WfloatPreparedText)
        self.assertTrue(
            hasattr(sherpa_onnx.OfflineTts, "convert_text_to_phonemes")
        )
        self.assertTrue(hasattr(sherpa_onnx.OfflineTts, "prepare_wfloat_text"))

        prepared = sherpa_onnx.prepare_wfloat_text(
            "Hello world. What now?!", emotion="joy", intensity=0.0
        )

        self.assertEqual(prepared.text, ["Hello world.", " What now?!"])
        self.assertEqual(
            prepared.text_clean, ["Hello world.😄⓪", "What now?😄⓪"]
        )
        self.assertEqual(prepared.text_phonemes, ["😄⓪", "😄⓪"])


if __name__ == "__main__":
    unittest.main()

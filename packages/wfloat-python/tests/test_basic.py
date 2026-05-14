import hashlib
import importlib
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import wfloat
from wfloat._assets import ModelAssets
from wfloat._cache import (
    CachedModelAssets,
    cache_model_assets,
    load_persistent_id,
    normalize_model_name,
    save_persistent_id,
)
from wfloat._model import Model
from wfloat import _native
from wfloat._results import Audio


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


class FakePreparedText:
    def __init__(self, *, text, text_clean):
        self.text = text
        self.text_clean = text_clean


class FakeGeneratedAudio:
    def __init__(self, samples, sample_rate):
        self.samples = samples
        self.sample_rate = sample_rate


class FakeNativeTts:
    def __init__(self, sample_rate=16000):
        self.sample_rate = sample_rate
        self.num_speakers = 20
        self.generate_calls = []

    def prepare_wfloat_text(self, text, emotion, intensity):
        del emotion, intensity

        if text == "Hello. World!":
            return FakePreparedText(
                text=["Hello.", " World!"],
                text_clean=["Hello.clean", "World.clean"],
            )

        if text == "The door is locked.":
            return FakePreparedText(
                text=["The door is locked."],
                text_clean=["door.clean"],
            )

        if text == "Then we open it the loud way.":
            return FakePreparedText(
                text=["Then we open it the loud way."],
                text_clean=["loud.clean"],
            )

        raise AssertionError(f"Unexpected text in fake native TTS: {text}")

    def generate(self, text, sid, speed):
        self.generate_calls.append((text, sid, speed))

        if text == "Hello.clean":
            return FakeGeneratedAudio([0.1, 0.2], self.sample_rate)
        if text == "World.clean":
            return FakeGeneratedAudio([0.3], self.sample_rate)
        if text == "door.clean":
            return FakeGeneratedAudio([0.4, 0.5], self.sample_rate)
        if text == "loud.clean":
            return FakeGeneratedAudio([0.6], self.sample_rate)

        raise AssertionError(f"Unexpected clean text in fake native TTS: {text}")


class TestWfloatSmoke(unittest.TestCase):
    def test_import_wfloat(self):
        self.assertTrue(hasattr(wfloat, "load"))
        self.assertTrue(hasattr(wfloat, "load_tts_model"))
        self.assertTrue(hasattr(wfloat, "Model"))
        self.assertTrue(hasattr(wfloat, "TtsModel"))
        self.assertTrue(hasattr(wfloat, "Audio"))
        self.assertTrue(hasattr(wfloat, "AudioResult"))
        self.assertTrue(hasattr(wfloat, "GenerationResult"))
        self.assertTrue(hasattr(wfloat, "TtsSynthesisResult"))
        self.assertIn("narrator_woman", wfloat.SPEAKER_IDS)

    def test_create_native_tts_prefers_wfloat_core_when_available(self):
        sentinel = object()

        with mock.patch.object(_native, "create_core_tts", return_value=sentinel) as mock_core:
            result = _native.create_native_tts(
                "wfloat/wfloat-tts",
                Path("/tmp/model.onnx"),
                Path("/tmp/tokens.txt"),
                Path("/tmp/espeak"),
            )

        self.assertIs(result, sentinel)
        mock_core.assert_called_once()

    def test_create_native_tts_falls_back_to_bindings(self):
        fake_bindings = types.SimpleNamespace(
            OfflineTtsWfloatModelConfig=lambda **kwargs: ("wfloat", kwargs),
            OfflineTtsModelConfig=lambda **kwargs: ("model", kwargs),
            OfflineTtsConfig=lambda **kwargs: ("config", kwargs),
            OfflineTts=lambda config: ("tts", config),
        )

        with mock.patch.object(
            _native, "create_core_tts", side_effect=ImportError("missing core")
        ), mock.patch.object(_native, "require_bindings", return_value=fake_bindings):
            result = _native.create_native_tts(
                "wfloat/wfloat-tts",
                Path("/tmp/model.onnx"),
                Path("/tmp/tokens.txt"),
                Path("/tmp/espeak"),
            )

        self.assertEqual(result[0], "tts")

    def test_audio_can_write_wave_bytes_without_numpy(self):
        audio = Audio(samples=[0.0, 0.5, -0.5], sample_rate=22050)
        wav_bytes = audio.wav_bytes()

        self.assertTrue(wav_bytes.startswith(b"RIFF"))
        self.assertGreater(len(wav_bytes), 44)

    def test_bindings_import_without_generated_audio(self):
        fake_module = types.SimpleNamespace(
            GenerationConfig=object(),
            OfflineTts=object(),
            OfflineTtsConfig=object(),
            OfflineTtsModelConfig=object(),
            OfflineTtsWfloatModelConfig=object(),
            WfloatPreparedText=object(),
            git_date="today",
            git_sha1="abc123",
            prepare_wfloat_text=lambda text, *args, **kwargs: text,
            version="1.12.24",
            write_wave=lambda *args, **kwargs: None,
        )

        original_module = sys.modules.pop("wfloat._bindings", None)
        try:
            with mock.patch.dict(sys.modules, {"sherpa_onnx": fake_module}):
                bindings = importlib.import_module("wfloat._bindings")
                self.assertIs(bindings.OfflineTts, fake_module.OfflineTts)
                self.assertNotIn("GeneratedAudio", bindings.__all__)
        finally:
            sys.modules.pop("wfloat._bindings", None)
            if original_module is not None:
                sys.modules["wfloat._bindings"] = original_module

    def test_generate_returns_audio_and_timeline(self):
        fake_native_tts = FakeNativeTts(sample_rate=10)
        model = Model("wfloat/wfloat-tts", fake_native_tts)

        result = model.generate(
            text="Hello. World!",
            voice_id="narrator_woman",
            emotion="neutral",
            intensity=0.5,
            speed=1.0,
            silence_padding_sec=0.2,
        )

        self.assertEqual(result.audio.sample_rate, 10)
        self.assertEqual(len(result.timeline.chunks), 2)
        self.assertEqual(result.timeline.chunks[0].highlight_start, 0)
        self.assertEqual(result.timeline.chunks[0].highlight_end, 6)
        self.assertEqual(result.timeline.chunks[1].highlight_start, 6)
        self.assertEqual(result.timeline.chunks[1].highlight_end, 13)
        self.assertAlmostEqual(result.timeline.chunks[0].start_sec, 0.0)
        self.assertAlmostEqual(result.timeline.chunks[0].end_sec, 0.2)
        self.assertAlmostEqual(result.timeline.chunks[1].start_sec, 0.4)
        self.assertAlmostEqual(result.timeline.chunks[1].end_sec, 0.5)
        self.assertAlmostEqual(result.audio.duration_sec, 0.5)
        self.assertEqual(fake_native_tts.generate_calls[0][1], 11)
        self.assertEqual(list(result), [result.audio, result.timeline])

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "out.wav"
            result.audio.save(output_path)
            self.assertTrue(output_path.is_file())

    def test_synthesize_alias_matches_generate_shape(self):
        fake_native_tts = FakeNativeTts(sample_rate=10)
        model = Model("wfloat/wfloat-tts", fake_native_tts)

        result = model.synthesize(
            text="Hello. World!",
            voice="narrator_woman",
            emotion="neutral",
            intensity=0.5,
            speed=1.0,
            silence_padding_sec=0.2,
        )

        self.assertEqual(result.model_id, "wfloat/wfloat-tts")
        self.assertEqual(result.audio.sample_rate, 10)
        self.assertEqual(len(result.timeline.chunks), 2)
        self.assertEqual(fake_native_tts.generate_calls[0][1], 11)

    def test_generate_dialogue_tracks_segment_indices(self):
        fake_native_tts = FakeNativeTts(sample_rate=10)
        model = Model("wfloat/wfloat-tts", fake_native_tts)

        result = model.generate_dialogue(
            segments=[
                {
                    "text": "The door is locked.",
                    "voice_id": "narrator_man",
                    "emotion": "neutral",
                },
                {
                    "text": "Then we open it the loud way.",
                    "voice_id": "strong_hero_woman",
                    "emotion": "joy",
                    "intensity": 0.65,
                },
            ],
            silence_between_segments_sec=0.3,
        )

        self.assertEqual(len(result.timeline.chunks), 2)
        self.assertEqual(result.timeline.chunks[0].segment_index, 0)
        self.assertEqual(result.timeline.chunks[1].segment_index, 1)
        self.assertAlmostEqual(result.timeline.chunks[1].start_sec, 0.5)

    def test_synthesize_dialogue_alias_matches_generate_dialogue(self):
        fake_native_tts = FakeNativeTts(sample_rate=10)
        model = Model("wfloat/wfloat-tts", fake_native_tts)

        result = model.synthesize_dialogue(
            segments=[
                {
                    "text": "The door is locked.",
                    "voice_id": "narrator_man",
                    "emotion": "neutral",
                },
                {
                    "text": "Then we open it the loud way.",
                    "voice_id": "strong_hero_woman",
                    "emotion": "joy",
                    "intensity": 0.65,
                },
            ],
            silence_between_segments_sec=0.3,
        )

        self.assertEqual(result.model_id, "wfloat/wfloat-tts")
        self.assertEqual(len(result.timeline.chunks), 2)
        self.assertEqual(result.timeline.chunks[0].segment_index, 0)
        self.assertEqual(result.timeline.chunks[1].segment_index, 1)

    def test_synthesize_dialogue_accepts_voice_alias(self):
        fake_native_tts = FakeNativeTts(sample_rate=10)
        model = Model("wfloat/wfloat-tts", fake_native_tts)

        result = model.synthesize_dialogue(
            segments=[
                {
                    "text": "The door is locked.",
                    "voice": "narrator_man",
                    "emotion": "neutral",
                },
                {
                    "text": "Then we open it the loud way.",
                    "voice": "strong_hero_woman",
                    "emotion": "joy",
                    "intensity": 0.65,
                },
            ],
            silence_between_segments_sec=0.3,
        )

        self.assertEqual(result.model_id, "wfloat/wfloat-tts")
        self.assertEqual(len(result.timeline.chunks), 2)
        self.assertEqual(result.timeline.chunks[0].sid, 10)
        self.assertEqual(result.timeline.chunks[1].sid, 5)

    def test_cache_model_assets_downloads_and_extracts_from_local_urls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_dir = root / "source"
            source_dir.mkdir()

            model_file = source_dir / "model.onnx"
            model_file.write_bytes(b"model-bytes")

            tokens_file = source_dir / "tokens.txt"
            tokens_file.write_text("token-bytes")

            espeak_archive = source_dir / "espeak.zip"
            with zipfile.ZipFile(espeak_archive, "w") as archive:
                archive.writestr("espeak-ng-data/voices.txt", "voice-data")

            assets = ModelAssets(
                model_onnx=model_file.as_uri(),
                model_onnx_checksum=sha256_file(model_file),
                model_tokens=tokens_file.as_uri(),
                model_tokens_checksum=sha256_file(tokens_file),
                espeak_data=espeak_archive.as_uri(),
                espeak_checksum=sha256_file(espeak_archive),
            )

            cached = cache_model_assets(
                "wfloat/wfloat-tts",
                assets,
                cache_dir=root / "cache",
            )

            self.assertTrue(cached.model_path.is_file())
            self.assertTrue(cached.tokens_path.is_file())
            self.assertTrue((cached.espeak_data_dir / "voices.txt").is_file())
            self.assertTrue(cached.manifest_path.is_file())
            self.assertEqual(
                normalize_model_name("wfloat/wfloat-tts"),
                "wfloat--wfloat-tts",
            )

    def test_persistent_id_is_stored_and_loaded_best_effort(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            self.assertIsNone(load_persistent_id(cache_dir))
            save_persistent_id("persist-123", cache_dir)
            self.assertEqual(load_persistent_id(cache_dir), "persist-123")

    def test_load_wires_endpoint_cache_and_native_builder(self):
        fake_assets = ModelAssets(
            model_onnx="https://example.com/model.onnx",
            model_onnx_checksum="abc",
            model_tokens="https://example.com/tokens.txt",
            model_tokens_checksum="def",
            espeak_data="https://example.com/espeak.zip",
            espeak_checksum="ghi",
            persistent_id="persist-456",
        )
        fake_cached = CachedModelAssets(
            model_name="wfloat/wfloat-tts",
            cache_dir=Path("/tmp/cache"),
            model_path=Path("/tmp/cache/model.onnx"),
            tokens_path=Path("/tmp/cache/tokens.txt"),
            espeak_data_dir=Path("/tmp/cache/espeak"),
            manifest_path=Path("/tmp/cache/manifest.json"),
        )
        fake_native_tts = FakeNativeTts()

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            save_persistent_id("persist-123", cache_dir)
            with mock.patch(
                "wfloat._model.fetch_model_assets",
                return_value=fake_assets,
            ) as fetch_mock, mock.patch(
                "wfloat._model.cache_model_assets",
                return_value=fake_cached,
            ), mock.patch(
                "wfloat._model.create_native_tts",
                return_value=fake_native_tts,
            ):
                model = wfloat.load("wfloat/wfloat-tts", cache_dir=cache_dir)

            self.assertIsInstance(model, Model)
            self.assertEqual(model.model_name, "wfloat/wfloat-tts")
            fetch_mock.assert_called_once_with(
                "wfloat/wfloat-tts",
                persistent_id="persist-123",
            )
            self.assertEqual(load_persistent_id(cache_dir), "persist-456")


if __name__ == "__main__":
    unittest.main()

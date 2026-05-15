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
from wfloat import _core
from wfloat._assets import ModelAssets, SttModelAssets
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
from wfloat._stt import SttModel
from wfloat._stt_assets import cache_stt_model_assets


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
        self.assertTrue(hasattr(wfloat, "load_stt_model"))
        self.assertTrue(hasattr(wfloat, "load_moonshine_tiny_en"))
        self.assertTrue(hasattr(wfloat, "load_whisper_tiny_en"))
        self.assertTrue(hasattr(wfloat, "Model"))
        self.assertTrue(hasattr(wfloat, "TtsModel"))
        self.assertTrue(hasattr(wfloat, "SttModel"))
        self.assertTrue(hasattr(wfloat, "Audio"))
        self.assertTrue(hasattr(wfloat, "AudioResult"))
        self.assertTrue(hasattr(wfloat, "GenerationResult"))
        self.assertTrue(hasattr(wfloat, "TtsSynthesisResult"))
        self.assertTrue(hasattr(wfloat, "TranscriptionResult"))
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

    def test_core_loader_uses_explicit_library_path(self):
        with mock.patch.dict(
            "os.environ",
            {"WFLOAT_CORE_LIBRARY": "/tmp/libwfloat-core.so"},
            clear=False,
        ):
            candidates = list(_core._iter_candidate_library_paths())

        self.assertEqual(candidates, [Path("/tmp/libwfloat-core.so")])

    def test_stt_model_transcribe_uses_native_backend(self):
        sentinel = wfloat.TranscriptionResult(
            text="hello world",
            model_id="openai/whisper-tiny-en",
        )
        native_stt = types.SimpleNamespace(
            transcribe_result=mock.Mock(return_value=sentinel)
        )
        model = SttModel(model_id="openai/whisper-tiny-en", _native_stt=native_stt)

        result = model.transcribe(audio=[0.1, -0.2], sample_rate=16000, language="en")

        self.assertIs(result, sentinel)
        native_stt.transcribe_result.assert_called_once()

    def test_load_stt_model_wires_cache_and_core_loader(self):
        fake_cached = types.SimpleNamespace(
            model_name="openai/whisper-tiny-en",
            family="whisper",
            encoder_path=Path("/tmp/cache/encoder.onnx"),
            decoder_path=Path("/tmp/cache/decoder.onnx"),
            tokens_path=Path("/tmp/cache/tokens.txt"),
            files={
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            },
            require=lambda key: {
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            }[key],
        )
        fake_native = object()

        with mock.patch(
            "wfloat._stt_load.cache_stt_assets",
            return_value=fake_cached,
        ) as cache_mock, mock.patch(
            "wfloat._stt_load.create_core_stt",
            return_value=fake_native,
        ) as create_mock:
            model = wfloat.load_stt_model(
                "openai/whisper-tiny-en",
                family="whisper",
                encoder="https://example.com/encoder.onnx",
                decoder="https://example.com/decoder.onnx",
                tokens="https://example.com/tokens.txt",
                language="en",
                task="transcribe",
            )

        self.assertIsInstance(model, SttModel)
        self.assertEqual(model.model_id, "openai/whisper-tiny-en")
        cache_mock.assert_called_once()
        create_mock.assert_called_once_with(
            model_name="openai/whisper-tiny-en",
            family="whisper",
            model_path=None,
            preprocessor_path=None,
            encoder_path=fake_cached.encoder_path,
            decoder_path=fake_cached.decoder_path,
            tokens_path=fake_cached.tokens_path,
            joiner_path=None,
            uncached_decoder_path=None,
            cached_decoder_path=None,
            language="en",
            task="transcribe",
            enable_token_timestamps=False,
            enable_segment_timestamps=False,
        )

    def test_load_stt_model_manifest_path_does_not_require_family(self):
        fake_assets = SttModelAssets(
            family="whisper",
            encoder="https://example.com/encoder.onnx",
            encoder_checksum="abc",
            decoder="https://example.com/decoder.onnx",
            decoder_checksum="def",
            tokens="https://example.com/tokens.txt",
            tokens_checksum="ghi",
        )
        fake_cached = types.SimpleNamespace(
            model_name="openai/whisper-tiny-en",
            family="whisper",
            files={
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            },
            require=lambda key: {
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            }[key],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            with mock.patch(
                "wfloat._stt_load.fetch_stt_assets",
                return_value=fake_assets,
            ) as fetch_mock, mock.patch(
                "wfloat._stt_load.cache_stt_model_assets",
                return_value=fake_cached,
            ), mock.patch(
                "wfloat._stt_load.create_core_stt",
                return_value=object(),
            ):
                model = wfloat.load_stt_model(
                    "openai/whisper-tiny-en",
                    cache_dir=cache_dir,
                )

        self.assertIsInstance(model, SttModel)
        fetch_mock.assert_called_once_with(
            "openai/whisper-tiny-en",
            family=None,
            persistent_id=None,
        )

    def test_load_stt_model_requires_family_for_explicit_sources(self):
        with self.assertRaisesRegex(ValueError, "family is required"):
            wfloat.load_stt_model(
                "openai/whisper-tiny-en",
                encoder="https://example.com/encoder.onnx",
                decoder="https://example.com/decoder.onnx",
                tokens="https://example.com/tokens.txt",
            )

    def test_load_stt_model_uses_asset_manifest_when_sources_are_not_provided(self):
        fake_assets = SttModelAssets(
            family="whisper",
            encoder="https://example.com/encoder.onnx",
            encoder_checksum="abc",
            decoder="https://example.com/decoder.onnx",
            decoder_checksum="def",
            tokens="https://example.com/tokens.txt",
            tokens_checksum="ghi",
            persistent_id="persist-456",
        )
        fake_cached = types.SimpleNamespace(
            model_name="openai/whisper-tiny-en",
            family="whisper",
            files={
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            },
            require=lambda key: {
                "encoder": Path("/tmp/cache/encoder.onnx"),
                "decoder": Path("/tmp/cache/decoder.onnx"),
                "tokens": Path("/tmp/cache/tokens.txt"),
            }[key],
        )
        fake_native = object()

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            save_persistent_id("persist-123", cache_dir)
            with mock.patch(
                "wfloat._stt_load.fetch_stt_assets",
                return_value=fake_assets,
            ) as fetch_mock, mock.patch(
                "wfloat._stt_load.cache_stt_model_assets",
                return_value=fake_cached,
            ) as cache_mock, mock.patch(
                "wfloat._stt_load.create_core_stt",
                return_value=fake_native,
            ) as create_mock:
                model = wfloat.load_stt_model(
                    "openai/whisper-tiny-en",
                    family="whisper",
                    cache_dir=cache_dir,
                )
            self.assertIsInstance(model, SttModel)
            fetch_mock.assert_called_once_with(
                "openai/whisper-tiny-en",
                family="whisper",
                persistent_id="persist-123",
            )
            cache_mock.assert_called_once_with(
                "openai/whisper-tiny-en",
                fake_assets,
                cache_dir=cache_dir,
                force_download=False,
            )
            create_mock.assert_called_once()
            self.assertEqual(load_persistent_id(cache_dir), "persist-456")

    def test_load_whisper_tiny_en_delegates_to_shared_loader(self):
        sentinel = object()

        with mock.patch(
            "wfloat._stt_load.load_stt_model",
            return_value=sentinel,
        ) as load_mock:
            result = wfloat.load_whisper_tiny_en(
                encoder_url="https://example.com/encoder.onnx",
                decoder_url="https://example.com/decoder.onnx",
                tokens_url="https://example.com/tokens.txt",
            )

        self.assertIs(result, sentinel)
        load_mock.assert_called_once()

    def test_load_moonshine_tiny_en_delegates_to_shared_loader(self):
        sentinel = object()

        with mock.patch(
            "wfloat._stt_load.load_stt_model",
            return_value=sentinel,
        ) as load_mock:
            result = wfloat.load_moonshine_tiny_en(
                preprocessor_url="https://example.com/preprocess.onnx",
                encoder_url="https://example.com/encode.onnx",
                uncached_decoder_url="https://example.com/uncached_decode.onnx",
                cached_decoder_url="https://example.com/cached_decode.onnx",
                tokens_url="https://example.com/tokens.txt",
            )

        self.assertIs(result, sentinel)
        load_mock.assert_called_once()

    def test_stt_assets_from_dict_supports_nested_files(self):
        assets = SttModelAssets.from_dict(
            {
                "family": "whisper",
                "files": {
                    "encoder": {"url": "https://example.com/encoder.onnx", "checksum": "abc"},
                    "decoder": {"url": "https://example.com/decoder.onnx"},
                    "tokens": {"url": "https://example.com/tokens.txt"},
                },
                "persistent_id": "persist-789",
            }
        )

        self.assertEqual(assets.family, "whisper")
        self.assertEqual(assets.encoder, "https://example.com/encoder.onnx")
        self.assertIsNone(assets.tokens_checksum)
        self.assertEqual(assets.persistent_id, "persist-789")

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

    def test_cache_stt_model_assets_downloads_from_local_urls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_dir = root / "source"
            source_dir.mkdir()

            encoder_file = source_dir / "encoder.onnx"
            encoder_file.write_bytes(b"encoder-bytes")

            decoder_file = source_dir / "decoder.onnx"
            decoder_file.write_bytes(b"decoder-bytes")

            tokens_file = source_dir / "tokens.txt"
            tokens_file.write_text("token-bytes")

            assets = SttModelAssets(
                family="whisper",
                encoder=encoder_file.as_uri(),
                encoder_checksum=sha256_file(encoder_file),
                decoder=decoder_file.as_uri(),
                decoder_checksum=sha256_file(decoder_file),
                tokens=tokens_file.as_uri(),
                tokens_checksum=sha256_file(tokens_file),
            )

            cached = cache_stt_model_assets(
                "openai/whisper-tiny-en",
                assets,
                cache_dir=root / "cache",
            )

            self.assertTrue(cached.require("encoder").is_file())
            self.assertTrue(cached.require("decoder").is_file())
            self.assertTrue(cached.require("tokens").is_file())

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

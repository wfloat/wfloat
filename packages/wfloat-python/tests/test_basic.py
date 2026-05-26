import hashlib
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

import wfloat
from wfloat import _assets, _core
from wfloat._assets import ModelAssets, SttModelAssets, VadModelAssets
from wfloat._cache import (
    CachedModelAssets,
    cache_model_assets,
    load_persistent_id,
    normalize_model_name,
    save_persistent_id,
)
from wfloat._model import Model
from wfloat import _native
from wfloat._assets import LlmModelAssets
from wfloat._llm import LlmModel
from wfloat._llm_assets import cache_llm_model_assets
from wfloat._results import Audio
from wfloat._stt import SttModel, SttSession
from wfloat._stt_assets import cache_stt_model_assets
from wfloat._vad import VadModel


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


class FakeVadSegment:
    def __init__(self, *, start, samples):
        self.start = start
        self.samples = samples


class FakeNativeVad:
    def __init__(self, segments=None):
        self.segments = list(segments or [])
        self.accepted = []
        self.reset_calls = 0
        self.flush_calls = 0
        self.pop_calls = 0

    def reset(self):
        self.reset_calls += 1

    def accept_waveform(self, samples):
        self.accepted.append(list(samples))

    def flush(self):
        self.flush_calls += 1

    def empty(self):
        return len(self.segments) == 0

    @property
    def front(self):
        return self.segments[0]

    def pop(self):
        self.pop_calls += 1
        self.segments.pop(0)


class TestWfloatSmoke(unittest.TestCase):
    def test_import_wfloat(self):
        self.assertTrue(hasattr(wfloat, "load"))
        self.assertTrue(hasattr(wfloat, "load_tts_model"))
        self.assertTrue(hasattr(wfloat, "load_stt_model"))
        self.assertTrue(hasattr(wfloat, "load_vad_model"))
        self.assertTrue(hasattr(wfloat, "load_llm_model"))
        self.assertTrue(hasattr(wfloat, "load_silero_vad"))
        self.assertTrue(hasattr(wfloat, "load_moonshine_tiny_en"))
        self.assertTrue(hasattr(wfloat, "load_whisper_tiny_en"))
        self.assertTrue(hasattr(wfloat, "Model"))
        self.assertTrue(hasattr(wfloat, "TtsModel"))
        self.assertTrue(hasattr(wfloat, "SttModel"))
        self.assertTrue(hasattr(wfloat, "SttSession"))
        self.assertTrue(hasattr(wfloat, "VadModel"))
        self.assertTrue(hasattr(wfloat, "LlmModel"))
        self.assertTrue(hasattr(wfloat, "Audio"))
        self.assertTrue(hasattr(wfloat, "AudioResult"))
        self.assertTrue(hasattr(wfloat, "GenerationResult"))
        self.assertTrue(hasattr(wfloat, "LlmGenerationResult"))
        self.assertTrue(hasattr(wfloat, "StreamingTranscriptionResult"))
        self.assertTrue(hasattr(wfloat, "TtsSynthesisResult"))
        self.assertTrue(hasattr(wfloat, "TranscriptionResult"))
        self.assertTrue(hasattr(wfloat, "VadDetectionResult"))
        self.assertTrue(hasattr(wfloat, "VadSegment"))
        self.assertIn("narrator_woman", wfloat.SPEAKER_IDS)

    def test_create_native_tts_uses_wfloat_core(self):
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

    def test_core_loader_uses_explicit_library_path(self):
        with mock.patch.dict(
            "os.environ",
            {"WFLOAT_CORE_LIBRARY": "/tmp/libwfloat-core.so"},
            clear=False,
        ):
            original_module = sys.modules.pop("wfloat_core", None)
            try:
                candidates = list(_core._iter_candidate_library_paths())
            finally:
                if original_module is not None:
                    sys.modules["wfloat_core"] = original_module

        self.assertEqual(candidates, [Path("/tmp/libwfloat-core.so")])

    def test_core_loader_prefers_packaged_runtime(self):
        fake_runtime = types.SimpleNamespace(
            get_library_path=lambda: "/tmp/packaged/libwfloat-core.so"
        )

        with mock.patch.dict(sys.modules, {"wfloat_core": fake_runtime}):
            with mock.patch.dict(
                "os.environ",
                {"WFLOAT_CORE_LIBRARY": "/tmp/libwfloat-core.so"},
                clear=False,
            ):
                candidates = list(_core._iter_candidate_library_paths())

        self.assertEqual(candidates, [Path("/tmp/packaged/libwfloat-core.so")])

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

    def test_stt_model_create_session_uses_native_backend(self):
        sentinel = object()
        native_stt = types.SimpleNamespace(create_session=mock.Mock(return_value=sentinel))
        model = SttModel(model_id="k2-fsa/streaming-zipformer-en", _native_stt=native_stt)

        session = model.create_session()

        self.assertIsInstance(session, SttSession)
        self.assertIs(session._native_session, sentinel)
        native_stt.create_session.assert_called_once()

    def test_stt_session_get_result_uses_native_backend(self):
        sentinel = wfloat.StreamingTranscriptionResult(
            text="HELLO WORLD",
            model_id="k2-fsa/streaming-zipformer-en",
            is_endpoint=False,
        )
        native_session = types.SimpleNamespace(
            get_result=mock.Mock(return_value=sentinel),
            push=mock.Mock(),
            finish=mock.Mock(return_value=sentinel),
            reset=mock.Mock(),
            close=mock.Mock(),
        )
        session = SttSession(
            model_id="k2-fsa/streaming-zipformer-en",
            _native_session=native_session,
        )

        result = session.get_result()
        session.push([0.1, -0.2], sample_rate=16000)
        session.reset()
        session.finish()
        session.close()

        self.assertIs(result, sentinel)
        native_session.get_result.assert_called_once()
        native_session.push.assert_called_once()
        native_session.reset.assert_called_once()
        native_session.finish.assert_called_once()
        native_session.close.assert_called_once()

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

    def test_load_vad_model_wires_cache_and_core_loader(self):
        fake_cached = types.SimpleNamespace(
            model_name="silero-vad",
            family="silero-vad",
            files={
                "model": Path("/tmp/cache/silero_vad.onnx"),
            },
            require=lambda key: {
                "model": Path("/tmp/cache/silero_vad.onnx"),
            }[key],
        )
        fake_native = object()

        with mock.patch(
            "wfloat._vad_load.cache_vad_assets",
            return_value=fake_cached,
        ) as cache_mock, mock.patch(
            "wfloat._vad_load.create_core_vad",
            return_value=fake_native,
        ) as create_mock:
            model = wfloat.load_vad_model(
                "silero-vad",
                family="silero-vad",
                model="https://example.com/silero_vad.onnx",
                threshold=0.6,
            )

        self.assertIsInstance(model, VadModel)
        self.assertEqual(model.model_id, "silero-vad")
        cache_mock.assert_called_once()
        create_mock.assert_called_once_with(
            model_name="silero-vad",
            family="silero-vad",
            model_path=Path("/tmp/cache/silero_vad.onnx"),
            threshold=0.6,
            min_silence_duration_sec=0.5,
            min_speech_duration_sec=0.25,
            max_speech_duration_sec=20.0,
            sample_rate=16000,
            buffer_size_in_seconds=30.0,
        )

    def test_load_vad_model_manifest_path_does_not_require_family(self):
        fake_assets = VadModelAssets(
            family="silero-vad",
            model="https://example.com/silero_vad.onnx",
            model_checksum="abc",
            persistent_id="persist-vad-2",
        )
        fake_cached = types.SimpleNamespace(
            model_name="silero-vad",
            family="silero-vad",
            files={
                "model": Path("/tmp/cache/silero_vad.onnx"),
            },
            require=lambda key: {
                "model": Path("/tmp/cache/silero_vad.onnx"),
            }[key],
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            save_persistent_id("persist-vad-1", cache_dir)
            with mock.patch(
                "wfloat._vad_load.fetch_vad_assets",
                return_value=fake_assets,
            ) as fetch_mock, mock.patch(
                "wfloat._vad_load.cache_vad_model_assets",
                return_value=fake_cached,
            ) as cache_mock, mock.patch(
                "wfloat._vad_load.create_core_vad",
                return_value=object(),
            ):
                model = wfloat.load_vad_model(
                    "silero-vad",
                    cache_dir=cache_dir,
                )

            self.assertIsInstance(model, VadModel)
            fetch_mock.assert_called_once_with(
                "silero-vad",
                family=None,
                persistent_id="persist-vad-1",
            )
            cache_mock.assert_called_once_with(
                "silero-vad",
                fake_assets,
                cache_dir=cache_dir,
                force_download=False,
            )
            self.assertEqual(load_persistent_id(cache_dir), "persist-vad-2")

    def test_load_vad_model_requires_family_for_explicit_sources(self):
        with self.assertRaisesRegex(ValueError, "family is required"):
            wfloat.load_vad_model(
                "silero-vad",
                model="https://example.com/silero_vad.onnx",
            )

    def test_llm_model_generate_uses_native_backend(self):
        sentinel = wfloat.LlmGenerationResult(
            text="local models work",
            model_id="smollm2-360m-instruct",
        )
        native_llm = types.SimpleNamespace(generate=mock.Mock(return_value=sentinel))
        model = LlmModel(
            model_id="smollm2-360m-instruct",
            family="smollm",
            _native_llm=native_llm,
            context_size=2048,
        )

        result = model.generate("Hello", max_tokens=8, temperature=0.0)

        self.assertIs(result, sentinel)
        native_llm.generate.assert_called_once_with(
            "Hello",
            max_tokens=8,
            temperature=0.0,
            top_p=0.95,
            top_k=40,
            repeat_penalty=1.0,
            seed=0,
            on_token=None,
        )

    def test_llm_model_chat_uses_native_backend(self):
        sentinel = wfloat.LlmGenerationResult(
            text="local chat works",
            model_id="smollm2-360m-instruct",
        )
        native_llm = types.SimpleNamespace(chat=mock.Mock(return_value=sentinel))
        model = LlmModel(
            model_id="smollm2-360m-instruct",
            family="smollm",
            _native_llm=native_llm,
            context_size=2048,
        )
        messages = [{"role": "user", "content": "Hello"}]

        result = model.chat(messages, max_tokens=8, temperature=0.0)

        self.assertIs(result, sentinel)
        native_llm.chat.assert_called_once_with(
            messages,
            max_tokens=8,
            temperature=0.0,
            top_p=0.95,
            top_k=40,
            repeat_penalty=1.0,
            seed=0,
            on_token=None,
        )

    def test_llm_model_format_chat_uses_native_backend(self):
        native_llm = types.SimpleNamespace(
            format_chat=mock.Mock(return_value="<|im_start|>user\nHello<|im_end|>\n")
        )
        model = LlmModel(
            model_id="smollm2-360m-instruct",
            family="smollm",
            _native_llm=native_llm,
            context_size=2048,
        )
        messages = [{"role": "user", "content": "Hello"}]

        prompt = model.format_chat(messages, add_generation_prompt=False)

        self.assertEqual(prompt, "<|im_start|>user\nHello<|im_end|>\n")
        native_llm.format_chat.assert_called_once_with(
            messages,
            add_generation_prompt=False,
        )

    def test_load_llm_model_uses_asset_manifest_when_sources_are_not_provided(self):
        fake_assets = LlmModelAssets(
            family="smollm",
            model="https://example.com/SmolLM2-360M-Instruct.Q4_K_M.gguf",
            model_checksum="abc",
            context_size=8192,
            chat_template_format="chatml",
            persistent_id="persist-llm-2",
        )
        fake_cached = types.SimpleNamespace(
            model_name="HuggingFaceTB/SmolLM2-360M-Instruct",
            family="smollm",
            context_size=8192,
            chat_template=None,
            chat_template_format="chatml",
            files={
                "model": Path("/tmp/cache/SmolLM2-360M-Instruct.Q4_K_M.gguf"),
            },
            require=lambda key: {
                "model": Path("/tmp/cache/SmolLM2-360M-Instruct.Q4_K_M.gguf"),
            }[key],
        )
        fake_native = object()

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            save_persistent_id("persist-llm-1", cache_dir)
            with mock.patch(
                "wfloat._llm_load.fetch_llm_assets",
                return_value=fake_assets,
            ) as fetch_mock, mock.patch(
                "wfloat._llm_load.cache_llm_model_assets",
                return_value=fake_cached,
            ) as cache_mock, mock.patch(
                "wfloat._llm_load.create_core_llm",
                return_value=fake_native,
            ) as create_mock:
                model = wfloat.load_llm_model(
                    "HuggingFaceTB/SmolLM2-360M-Instruct",
                    cache_dir=cache_dir,
                )

            self.assertIsInstance(model, LlmModel)
            fetch_mock.assert_called_once_with(
                "HuggingFaceTB/SmolLM2-360M-Instruct",
                family=None,
                persistent_id="persist-llm-1",
            )
            cache_mock.assert_called_once_with(
                "HuggingFaceTB/SmolLM2-360M-Instruct",
                fake_assets,
                cache_dir=cache_dir,
                force_download=False,
            )
            create_mock.assert_called_once_with(
                model_name="HuggingFaceTB/SmolLM2-360M-Instruct",
                family="smollm",
                model_path=Path("/tmp/cache/SmolLM2-360M-Instruct.Q4_K_M.gguf"),
                context_size=8192,
                num_threads=4,
                gpu_layer_count=0,
                chat_template="chatml",
            )
            self.assertEqual(load_persistent_id(cache_dir), "persist-llm-2")

    def test_load_llm_model_requires_family_for_explicit_sources(self):
        with self.assertRaisesRegex(ValueError, "family is required"):
            wfloat.load_llm_model(
                "HuggingFaceTB/SmolLM2-360M-Instruct",
                model="https://example.com/model.gguf",
            )

    def test_llm_assets_from_dict_supports_nested_files(self):
        assets = LlmModelAssets.from_dict(
            {
                "family": "smollm",
                "context_size": 8192,
                "chat_template_format": "chatml",
                "files": {
                    "model": {
                        "url": "https://example.com/model.gguf",
                        "checksum": "abc",
                    },
                },
                "persistent_id": "persist-llm",
            }
        )

        self.assertEqual(assets.family, "smollm")
        self.assertEqual(assets.model, "https://example.com/model.gguf")
        self.assertEqual(assets.model_checksum, "abc")
        self.assertEqual(assets.context_size, 8192)
        self.assertEqual(assets.chat_template_format, "chatml")
        self.assertEqual(assets.persistent_id, "persist-llm")

    def test_cache_llm_model_assets_downloads_from_local_urls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source = root / "model.gguf"
            source.write_bytes(b"fake-gguf")
            checksum = sha256_file(source)

            cached = cache_llm_model_assets(
                "HuggingFaceTB/SmolLM2-360M-Instruct",
                LlmModelAssets(
                    family="smollm",
                    model=source.as_uri(),
                    model_checksum=checksum,
                    context_size=8192,
                ),
                cache_dir=root / "cache",
            )

            self.assertEqual(cached.family, "smollm")
            self.assertEqual(cached.context_size, 8192)
            self.assertEqual(cached.require("model").read_bytes(), b"fake-gguf")

    def test_vad_model_detect_uses_exact_windows_and_maps_segments(self):
        native_vad = FakeNativeVad(
            segments=[
                FakeVadSegment(start=512, samples=[0.1, 0.2, -0.1]),
            ]
        )
        model = VadModel(
            model_id="silero-vad",
            family="silero-vad",
            _native_vad=native_vad,
        )

        result = model.detect(audio=[0.0] * 1025, sample_rate=16000)

        self.assertEqual([len(chunk) for chunk in native_vad.accepted], [512, 512, 1])
        self.assertEqual(native_vad.reset_calls, 1)
        self.assertEqual(native_vad.flush_calls, 1)
        self.assertEqual(native_vad.pop_calls, 1)
        self.assertEqual(result.model_id, "silero-vad")
        self.assertEqual(len(result.segments), 1)
        self.assertAlmostEqual(result.segments[0].start_sec, 512 / 16000)
        self.assertEqual(result.segments[0].sample_count, 3)
        self.assertEqual(result.segments[0].audio.samples, [0.1, 0.2, -0.1])
        self.assertAlmostEqual(result.speech_ratio, 3 / 1025)

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

    def test_vad_assets_from_dict_supports_nested_files(self):
        assets = VadModelAssets.from_dict(
            {
                "family": "silero-vad",
                "files": {
                    "model": {
                        "url": "https://example.com/silero_vad.onnx",
                        "checksum": "abc",
                    },
                },
                "persistent_id": "persist-vad",
            }
        )

        self.assertEqual(assets.family, "silero-vad")
        self.assertEqual(assets.model, "https://example.com/silero_vad.onnx")
        self.assertEqual(assets.model_checksum, "abc")
        self.assertEqual(assets.persistent_id, "persist-vad")

    def test_audio_can_write_wave_bytes_without_numpy(self):
        audio = Audio(samples=[0.0, 0.5, -0.5], sample_rate=22050)
        wav_bytes = audio.wav_bytes()

        self.assertTrue(wav_bytes.startswith(b"RIFF"))
        self.assertGreater(len(wav_bytes), 44)

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

    def test_fetch_stt_assets_infers_capability_from_model_name(self):
        payload = b'{"family":"zipformer-transducer","files":{"tokens":{"url":"https://example.com/tokens.txt"}}}'

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return payload

        with mock.patch("wfloat._assets.urlopen", return_value=_FakeResponse()) as urlopen_mock:
            assets = _assets.fetch_stt_assets(
                "k2-fsa/streaming-zipformer-en",
                family="zipformer-transducer",
                persistent_id="persist-123",
                package_version_override="1.5.2",
            )

        self.assertEqual(assets.family, "zipformer-transducer")
        request = urlopen_mock.call_args.args[0]
        parsed = urlparse(request.full_url)
        query = parse_qs(parsed.query)
        self.assertEqual(query["model_name"], ["k2-fsa/streaming-zipformer-en"])
        self.assertEqual(query["platform"], ["python"])
        self.assertEqual(query["version"], ["1.5.2"])
        self.assertEqual(query["family"], ["zipformer-transducer"])
        self.assertEqual(query["persistent_id"], ["persist-123"])
        self.assertNotIn("capability", query)

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

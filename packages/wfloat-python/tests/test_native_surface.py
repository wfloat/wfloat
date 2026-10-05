"""Opt-in end-to-end public API checks, with no model downloads in the tests.

Set WFLOAT_TEST_MODEL_CACHE plus both native-library environment variables.
The cache must contain SmolLM2-360M, wfloat-tts, Whisper tiny.en and Silero VAD.
"""
import os
from pathlib import Path
import threading

import numpy as np
import pytest

import wfloat


@pytest.fixture
def cache():
    value = os.environ.get("WFLOAT_TEST_MODEL_CACHE")
    if not value or not os.environ.get("WFLOAT_CORE_LIBRARY") or not os.environ.get("WFLOAT_LLM_LIBRARY"):
        pytest.skip("configure the native integration cache and libraries")
    root = Path(value)
    from wfloat._lifecycle import _assets
    for name in ("HuggingFaceTB/SmolLM2-360M-Instruct", "wfloat/wfloat-tts",
                 "openai/whisper-tiny-en", "snakers4/silero-vad"):
        if not all(asset.path.is_file() for asset in _assets(name, root)):
            pytest.skip(f"missing predownloaded assets for {name}")
    return root


def test_public_language_load_stream_schema_cancel_and_reuse(cache):
    phases = []
    with wfloat.load_language_model(
        "HuggingFaceTB/SmolLM2-360M-Instruct", cache_dir=cache,
        context_size=512, num_threads=2, on_progress=lambda e: phases.append(e.phase),
    ) as model:
        messages = [{"role": "user", "content": "Say hello."}]
        with model.generate_stream(messages, max_tokens_per_round=8, temperature=0) as stream:
            first = next(stream)
            assert first.type == "round_start"
            result = stream.result()
            assert stream.result() is result
            assert list(stream) == []
        assert result.text and result.usage.output_tokens > 0
        assert result.new_messages and len(messages) == 1
        schema = {"type": "object", "properties": {"ok": {"const": True}},
                  "required": ["ok"], "additionalProperties": False}
        structured = model.generate(messages, structured_output=wfloat.StructuredOutput(schema),
                                    max_tokens_per_round=40, temperature=0)
        assert structured.output == {"ok": True}
        stop = threading.Event()
        stop.set()
        cancelled = model.generate(messages, cancel_event=stop)
        assert cancelled.stop_reason == "cancelled" and stop.is_set()
        assert model.generate(messages, max_tokens_per_round=2).usage.output_tokens > 0
    assert phases == ["checking", "loading", "ready"]
    assert result.text  # results survive native unload


def test_public_audio_roundtrip_and_live_clip_retention(cache, tmp_path):
    with wfloat.load_text_to_speech("wfloat/wfloat-tts", cache_dir=cache) as model:
        speech = model.generate("Hello world. This is a test.")
        with model.generate_stream("Hello. Another sentence.") as stream:
            chunk = next(stream)
            held = chunk.audio.samples.copy()
        np.testing.assert_array_equal(chunk.audio.samples, held)
    path = tmp_path / "speech.wav"
    speech.audio.save(path)
    with wfloat.load_speech_to_text("openai/whisper-tiny-en", cache_dir=cache) as model:
        transcript = model.transcribe(path)
        assert transcript.text.strip() and transcript.stop_reason == "complete"
    with wfloat.load_voice_activity_detection("snakers4/silero-vad", cache_dir=cache) as model:
        detected = model.detect(speech.audio, return_audio=True)
        assert detected.segments and detected.segments[0].audio is not None
        clips = []
        session = model.create_session(return_audio=True, on_speech_end=clips.append)
        try:
            session.push(speech.audio)
            summary = session.finish()
        finally:
            session.cancel()
        assert clips and summary.segments
        assert all(not hasattr(segment, "audio") for segment in summary.segments)
    assert len(clips[0].audio.samples) > 0

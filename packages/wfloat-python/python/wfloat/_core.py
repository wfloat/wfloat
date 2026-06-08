import ctypes
import os
import platform
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from ._constants import (
    DEFAULT_INTENSITY,
    DEFAULT_PROVIDER,
    DEFAULT_SPEED,
)
from ._results import (
    Audio,
    GenerationResult,
    LlmGenerationResult,
    StreamingTranscriptionResult,
    Timeline,
    TimelineChunk,
    TranscriptionResult,
    TranscriptionSegment,
    TranscriptionToken,
)

WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE = 1
WFLOAT_STT_FAMILY_WHISPER = 1
WFLOAT_STT_FAMILY_MOONSHINE = 2
WFLOAT_STT_FAMILY_PARAKEET_CTC = 3
WFLOAT_STT_FAMILY_PARAKEET_TDT = 4
WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER = 5
WFLOAT_VAD_FAMILY_SILERO = 1
WFLOAT_VAD_FAMILY_TEN = 2
WFLOAT_LLM_FAMILY_LLAMA = 1
WFLOAT_LLM_FAMILY_QWEN = 2
WFLOAT_LLM_FAMILY_SMOLLM = 3
WFLOAT_LLM_FAMILY_GEMMA = 4
WFLOAT_LLM_FAMILY_MISTRAL = 5
WFLOAT_LLM_FAMILY_PHI = 6
WFLOAT_LLM_FAMILY_LIQUID = 7
WFLOAT_STATUS_OK = 0


class _WfloatStringMapEntry(ctypes.Structure):
    _fields_ = [
        ("key", ctypes.c_char_p),
        ("value", ctypes.c_char_p),
    ]


class _WfloatAudioResult(ctypes.Structure):
    _fields_ = [
        ("samples", ctypes.POINTER(ctypes.c_float)),
        ("sample_count", ctypes.c_size_t),
        ("sample_rate", ctypes.c_int32),
        ("duration_sec", ctypes.c_float),
    ]


class _WfloatTimelineChunk(ctypes.Structure):
    _fields_ = [
        ("index", ctypes.c_int32),
        ("text", ctypes.c_char_p),
        ("highlight_start", ctypes.c_int32),
        ("highlight_end", ctypes.c_int32),
        ("start_sec", ctypes.c_float),
        ("end_sec", ctypes.c_float),
        ("duration_sec", ctypes.c_float),
        ("progress", ctypes.c_float),
        ("voice", ctypes.c_char_p),
        ("sid", ctypes.c_int32),
        ("segment_index", ctypes.c_int32),
    ]


class _WfloatTimeline(ctypes.Structure):
    _fields_ = [
        ("chunks", ctypes.POINTER(_WfloatTimelineChunk)),
        ("chunk_count", ctypes.c_size_t),
        ("duration_sec", ctypes.c_float),
    ]


class _WfloatTtsSynthesisResult(ctypes.Structure):
    _fields_ = [
        ("audio", _WfloatAudioResult),
        ("timeline", _WfloatTimeline),
        ("model_id", ctypes.c_char_p),
        ("text", ctypes.c_char_p),
    ]


class _WfloatTtsSynthesizeOptions(ctypes.Structure):
    _fields_ = [
        ("text", ctypes.c_char_p),
        ("voice", ctypes.c_char_p),
        ("sid", ctypes.c_int32),
        ("speed", ctypes.c_float),
        ("silence_padding_sec", ctypes.c_float),
        ("reference_audio", ctypes.POINTER(ctypes.c_float)),
        ("reference_audio_sample_count", ctypes.c_size_t),
        ("reference_audio_sample_rate", ctypes.c_int32),
        ("reference_text", ctypes.c_char_p),
        ("num_steps", ctypes.c_int32),
        ("extra_entries", ctypes.POINTER(_WfloatStringMapEntry)),
        ("extra_entry_count", ctypes.c_size_t),
    ]


class _WfloatTtsDialogueSegment(ctypes.Structure):
    _fields_ = [
        ("text", ctypes.c_char_p),
        ("voice", ctypes.c_char_p),
        ("sid", ctypes.c_int32),
        ("speed", ctypes.c_float),
        ("silence_padding_sec", ctypes.c_float),
        ("extra_entries", ctypes.POINTER(_WfloatStringMapEntry)),
        ("extra_entry_count", ctypes.c_size_t),
    ]


class _WfloatTtsDialogueOptions(ctypes.Structure):
    _fields_ = [
        ("segments", ctypes.POINTER(_WfloatTtsDialogueSegment)),
        ("segment_count", ctypes.c_size_t),
        ("silence_between_segments_sec", ctypes.c_float),
    ]


class _WfloatTtsModelInfo(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("backend", ctypes.c_char_p),
        ("family", ctypes.c_char_p),
        ("feature_flags", ctypes.c_uint64),
        ("sample_rate", ctypes.c_int32),
        ("num_speakers", ctypes.c_int32),
    ]


class _WfloatTtsModelConfig(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("family", ctypes.c_int32),
        ("model_path", ctypes.c_char_p),
        ("tokens_path", ctypes.c_char_p),
        ("data_dir", ctypes.c_char_p),
        ("lexicon_path", ctypes.c_char_p),
        ("voices_path", ctypes.c_char_p),
        ("lang", ctypes.c_char_p),
        ("acoustic_model_path", ctypes.c_char_p),
        ("vocoder_path", ctypes.c_char_p),
        ("encoder_path", ctypes.c_char_p),
        ("decoder_path", ctypes.c_char_p),
        ("text_conditioner_path", ctypes.c_char_p),
        ("lm_flow_path", ctypes.c_char_p),
        ("lm_main_path", ctypes.c_char_p),
        ("vocab_json_path", ctypes.c_char_p),
        ("token_scores_json_path", ctypes.c_char_p),
        ("num_threads", ctypes.c_int32),
        ("debug", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("rule_fsts", ctypes.c_char_p),
        ("rule_fars", ctypes.c_char_p),
        ("max_num_sentences", ctypes.c_int32),
        ("silence_scale", ctypes.c_float),
        ("noise_scale", ctypes.c_float),
        ("noise_scale_w", ctypes.c_float),
        ("length_scale", ctypes.c_float),
        ("feat_scale", ctypes.c_float),
        ("t_shift", ctypes.c_float),
        ("target_rms", ctypes.c_float),
        ("guidance_scale", ctypes.c_float),
    ]


class _WfloatSttToken(ctypes.Structure):
    _fields_ = [
        ("text", ctypes.c_char_p),
        ("start_sec", ctypes.c_float),
        ("duration_sec", ctypes.c_float),
        ("confidence", ctypes.c_float),
    ]


class _WfloatSttSegment(ctypes.Structure):
    _fields_ = [
        ("text", ctypes.c_char_p),
        ("start_sec", ctypes.c_float),
        ("duration_sec", ctypes.c_float),
    ]


class _WfloatSttTranscriptionResult(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("text", ctypes.c_char_p),
        ("language", ctypes.c_char_p),
        ("emotion", ctypes.c_char_p),
        ("event", ctypes.c_char_p),
        ("json", ctypes.c_char_p),
        ("tokens", ctypes.POINTER(_WfloatSttToken)),
        ("token_count", ctypes.c_size_t),
        ("segments", ctypes.POINTER(_WfloatSttSegment)),
        ("segment_count", ctypes.c_size_t),
    ]


class _WfloatSttSessionResult(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("text", ctypes.c_char_p),
        ("json", ctypes.c_char_p),
        ("is_endpoint", ctypes.c_int32),
    ]


class _WfloatSttModelInfo(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("backend", ctypes.c_char_p),
        ("family", ctypes.c_char_p),
        ("feature_flags", ctypes.c_uint64),
        ("sample_rate", ctypes.c_int32),
        ("supports_language_override", ctypes.c_int32),
    ]


class _WfloatSttModelConfig(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("family", ctypes.c_int32),
        ("model_path", ctypes.c_char_p),
        ("tokens_path", ctypes.c_char_p),
        ("preprocessor_path", ctypes.c_char_p),
        ("encoder_path", ctypes.c_char_p),
        ("decoder_path", ctypes.c_char_p),
        ("joiner_path", ctypes.c_char_p),
        ("uncached_decoder_path", ctypes.c_char_p),
        ("cached_decoder_path", ctypes.c_char_p),
        ("provider", ctypes.c_char_p),
        ("language", ctypes.c_char_p),
        ("task", ctypes.c_char_p),
        ("hotwords_file", ctypes.c_char_p),
        ("rule_fsts", ctypes.c_char_p),
        ("rule_fars", ctypes.c_char_p),
        ("sample_rate", ctypes.c_int32),
        ("feat_dim", ctypes.c_int32),
        ("num_threads", ctypes.c_int32),
        ("debug", ctypes.c_int32),
        ("max_active_paths", ctypes.c_int32),
        ("tail_paddings", ctypes.c_int32),
        ("enable_token_timestamps", ctypes.c_int32),
        ("enable_segment_timestamps", ctypes.c_int32),
        ("hotwords_score", ctypes.c_float),
        ("blank_penalty", ctypes.c_float),
    ]


class _WfloatSttTranscribeOptions(ctypes.Structure):
    _fields_ = [
        ("samples", ctypes.POINTER(ctypes.c_float)),
        ("sample_count", ctypes.c_size_t),
        ("sample_rate", ctypes.c_int32),
        ("language", ctypes.c_char_p),
        ("task", ctypes.c_char_p),
        ("hotwords", ctypes.c_char_p),
    ]


class _WfloatVadModelConfig(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("family", ctypes.c_int32),
        ("model_path", ctypes.c_char_p),
        ("threshold", ctypes.c_float),
        ("min_silence_duration_sec", ctypes.c_float),
        ("min_speech_duration_sec", ctypes.c_float),
        ("max_speech_duration_sec", ctypes.c_float),
        ("sample_rate", ctypes.c_int32),
        ("window_size", ctypes.c_int32),
        ("num_threads", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("debug", ctypes.c_int32),
        ("buffer_size_in_seconds", ctypes.c_float),
    ]


class _WfloatVadModelInfo(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("backend", ctypes.c_char_p),
        ("family", ctypes.c_char_p),
        ("feature_flags", ctypes.c_uint64),
        ("sample_rate", ctypes.c_int32),
        ("window_size", ctypes.c_int32),
    ]


class _WfloatVadSegment(ctypes.Structure):
    _fields_ = [
        ("start_sample", ctypes.c_int32),
        ("samples", ctypes.POINTER(ctypes.c_float)),
        ("sample_count", ctypes.c_size_t),
    ]


class _WfloatLlmModelConfig(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("family", ctypes.c_int32),
        ("model_path", ctypes.c_char_p),
        ("chat_template", ctypes.c_char_p),
        ("provider", ctypes.c_char_p),
        ("context_size", ctypes.c_int32),
        ("num_threads", ctypes.c_int32),
        ("gpu_layer_count", ctypes.c_int32),
        ("seed", ctypes.c_int32),
    ]


class _WfloatLlmModelInfo(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("backend", ctypes.c_char_p),
        ("family", ctypes.c_char_p),
        ("feature_flags", ctypes.c_uint64),
        ("context_size", ctypes.c_int32),
    ]


class _WfloatLlmGenerateOptions(ctypes.Structure):
    _fields_ = [
        ("prompt", ctypes.c_char_p),
        ("max_tokens", ctypes.c_int32),
        ("temperature", ctypes.c_float),
        ("top_p", ctypes.c_float),
        ("top_k", ctypes.c_int32),
        ("repeat_penalty", ctypes.c_float),
        ("seed", ctypes.c_int32),
    ]


class _WfloatLlmTokenEvent(ctypes.Structure):
    _fields_ = [
        ("text", ctypes.c_char_p),
        ("token_index", ctypes.c_int32),
        ("token_id", ctypes.c_int32),
        ("is_done", ctypes.c_int32),
    ]


class _WfloatLlmGenerateResult(ctypes.Structure):
    _fields_ = [
        ("model_id", ctypes.c_char_p),
        ("text", ctypes.c_char_p),
        ("finish_reason", ctypes.c_char_p),
        ("json", ctypes.c_char_p),
        ("prompt_token_count", ctypes.c_int32),
        ("completion_token_count", ctypes.c_int32),
    ]


class _WfloatLlmChatMessage(ctypes.Structure):
    _fields_ = [
        ("role", ctypes.c_char_p),
        ("content", ctypes.c_char_p),
    ]


class _WfloatLlmChatTemplateOptions(ctypes.Structure):
    _fields_ = [
        ("messages", ctypes.POINTER(_WfloatLlmChatMessage)),
        ("message_count", ctypes.c_size_t),
        ("add_generation_prompt", ctypes.c_int32),
    ]


class _WfloatLlmChatTemplateResult(ctypes.Structure):
    _fields_ = [
        ("prompt", ctypes.c_char_p),
        ("chat_template", ctypes.c_char_p),
        ("json", ctypes.c_char_p),
        ("used_fallback", ctypes.c_int32),
    ]


_WfloatLlmTokenCallback = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.POINTER(_WfloatLlmTokenEvent),
    ctypes.c_void_p,
)


class _CoreLibraryError(ImportError):
    pass


_DLL_DIRECTORY_HANDLES = []


def _decode(value: Optional[bytes]) -> str:
    return value.decode("utf-8") if value else ""


def _native_dir() -> Path:
    return Path(__file__).resolve().parent / "native"


def _library_names() -> tuple[str, ...]:
    if sys.platform == "win32":
        return ("wfloat-core.dll", "libwfloat-core.dll")
    if sys.platform == "darwin":
        return ("libwfloat-core.dylib",)
    return ("libwfloat-core.so",)


def _iter_packaged_library_paths() -> Sequence[Path]:
    native_dir = _native_dir()
    return [native_dir / name for name in _library_names()]


def _iter_candidate_library_paths() -> Sequence[Path]:
    candidates: List[Path] = []

    env_path = os.environ.get("WFLOAT_CORE_LIBRARY")
    if env_path:
        candidates.append(Path(env_path))

    candidates.extend(
        candidate for candidate in _iter_packaged_library_paths() if candidate.exists()
    )

    try:
        import wfloat_core

        candidates.append(Path(wfloat_core.get_library_path()))
    except ImportError:
        pass

    repo_root = Path(__file__).resolve().parents[4]
    for pattern in (
        "out/**/libwfloat-core.so",
        "out/**/libwfloat-core.dylib",
        "out/**/wfloat-core.dll",
        "build/**/libwfloat-core.so",
        "build/**/libwfloat-core.dylib",
        "build/**/wfloat-core.dll",
    ):
        candidates.extend(repo_root.glob(pattern))

    return candidates


def _prepare_dll_directory(candidate: Path) -> None:
    if sys.platform != "win32" or not hasattr(os, "add_dll_directory"):
        return

    native_dir = candidate.parent
    if not native_dir.exists():
        return

    # Keep the handle alive so dependent DLL lookup stays enabled.
    _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(native_dir)))


def _load_core_library() -> ctypes.CDLL:
    errors: List[str] = []

    for candidate in _iter_candidate_library_paths():
        try:
            _prepare_dll_directory(candidate)
            return ctypes.CDLL(str(candidate))
        except OSError as exc:
            errors.append(f"{candidate}: {exc}")

    if errors:
        raise _CoreLibraryError(
            "Failed to load wfloat-core shared library. "
            + " ".join(errors)
        )

    raise _CoreLibraryError(
        "Could not find a built wfloat-core shared library. "
        f"Looked in {_native_dir()} for {', '.join(_library_names())} on "
        f"{sys.platform}/{platform.machine() or 'unknown'}. "
        "Set WFLOAT_CORE_LIBRARY or build wfloat-core as a shared library."
    )


def _prepare_library(lib: ctypes.CDLL) -> ctypes.CDLL:
    lib.wfloat_tts_model_create.argtypes = [
        ctypes.POINTER(_WfloatTtsModelConfig),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.wfloat_tts_model_create.restype = ctypes.c_int32

    lib.wfloat_tts_model_destroy.argtypes = [ctypes.c_void_p]
    lib.wfloat_tts_model_destroy.restype = None

    lib.wfloat_tts_model_get_info.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatTtsModelInfo),
    ]
    lib.wfloat_tts_model_get_info.restype = ctypes.c_int32

    lib.wfloat_tts_model_synthesize.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatTtsSynthesizeOptions),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatTtsSynthesisResult)),
    ]
    lib.wfloat_tts_model_synthesize.restype = ctypes.c_int32

    lib.wfloat_tts_model_synthesize_dialogue.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatTtsDialogueOptions),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatTtsSynthesisResult)),
    ]
    lib.wfloat_tts_model_synthesize_dialogue.restype = ctypes.c_int32

    lib.wfloat_tts_synthesis_result_destroy.argtypes = [
        ctypes.POINTER(_WfloatTtsSynthesisResult)
    ]
    lib.wfloat_tts_synthesis_result_destroy.restype = None

    lib.wfloat_stt_model_create.argtypes = [
        ctypes.POINTER(_WfloatSttModelConfig),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.wfloat_stt_model_create.restype = ctypes.c_int32

    lib.wfloat_stt_model_destroy.argtypes = [ctypes.c_void_p]
    lib.wfloat_stt_model_destroy.restype = None

    lib.wfloat_stt_model_get_info.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatSttModelInfo),
    ]
    lib.wfloat_stt_model_get_info.restype = ctypes.c_int32

    lib.wfloat_stt_model_transcribe.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatSttTranscribeOptions),
        ctypes.POINTER(ctypes.POINTER(_WfloatSttTranscriptionResult)),
    ]
    lib.wfloat_stt_model_transcribe.restype = ctypes.c_int32

    lib.wfloat_stt_model_create_session.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.wfloat_stt_model_create_session.restype = ctypes.c_int32

    lib.wfloat_stt_session_push_audio.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_size_t,
        ctypes.c_int32,
    ]
    lib.wfloat_stt_session_push_audio.restype = ctypes.c_int32

    lib.wfloat_stt_session_get_result.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatSttSessionResult)),
    ]
    lib.wfloat_stt_session_get_result.restype = ctypes.c_int32

    lib.wfloat_stt_session_finish.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatSttSessionResult)),
    ]
    lib.wfloat_stt_session_finish.restype = ctypes.c_int32

    lib.wfloat_stt_session_reset.argtypes = [ctypes.c_void_p]
    lib.wfloat_stt_session_reset.restype = ctypes.c_int32

    lib.wfloat_stt_session_destroy.argtypes = [ctypes.c_void_p]
    lib.wfloat_stt_session_destroy.restype = None

    lib.wfloat_stt_session_result_destroy.argtypes = [
        ctypes.POINTER(_WfloatSttSessionResult)
    ]
    lib.wfloat_stt_session_result_destroy.restype = None

    lib.wfloat_stt_transcription_result_destroy.argtypes = [
        ctypes.POINTER(_WfloatSttTranscriptionResult)
    ]
    lib.wfloat_stt_transcription_result_destroy.restype = None

    lib.wfloat_vad_model_create.argtypes = [
        ctypes.POINTER(_WfloatVadModelConfig),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.wfloat_vad_model_create.restype = ctypes.c_int32

    lib.wfloat_vad_model_destroy.argtypes = [ctypes.c_void_p]
    lib.wfloat_vad_model_destroy.restype = None

    lib.wfloat_vad_model_get_info.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatVadModelInfo),
    ]
    lib.wfloat_vad_model_get_info.restype = ctypes.c_int32

    lib.wfloat_vad_model_accept_waveform.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_size_t,
    ]
    lib.wfloat_vad_model_accept_waveform.restype = ctypes.c_int32

    lib.wfloat_vad_model_reset.argtypes = [ctypes.c_void_p]
    lib.wfloat_vad_model_reset.restype = ctypes.c_int32

    lib.wfloat_vad_model_flush.argtypes = [ctypes.c_void_p]
    lib.wfloat_vad_model_flush.restype = ctypes.c_int32

    lib.wfloat_vad_model_empty.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int32),
    ]
    lib.wfloat_vad_model_empty.restype = ctypes.c_int32

    lib.wfloat_vad_model_detected.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int32),
    ]
    lib.wfloat_vad_model_detected.restype = ctypes.c_int32

    lib.wfloat_vad_model_front.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatVadSegment)),
    ]
    lib.wfloat_vad_model_front.restype = ctypes.c_int32

    lib.wfloat_vad_model_pop.argtypes = [ctypes.c_void_p]
    lib.wfloat_vad_model_pop.restype = ctypes.c_int32

    lib.wfloat_vad_model_clear.argtypes = [ctypes.c_void_p]
    lib.wfloat_vad_model_clear.restype = ctypes.c_int32

    lib.wfloat_vad_segment_destroy.argtypes = [
        ctypes.POINTER(_WfloatVadSegment)
    ]
    lib.wfloat_vad_segment_destroy.restype = None

    lib.wfloat_llm_model_create.argtypes = [
        ctypes.POINTER(_WfloatLlmModelConfig),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.wfloat_llm_model_create.restype = ctypes.c_int32

    lib.wfloat_llm_model_destroy.argtypes = [ctypes.c_void_p]
    lib.wfloat_llm_model_destroy.restype = None

    lib.wfloat_llm_model_get_info.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatLlmModelInfo),
    ]
    lib.wfloat_llm_model_get_info.restype = ctypes.c_int32

    lib.wfloat_llm_model_generate.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatLlmGenerateOptions),
        _WfloatLlmTokenCallback,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.POINTER(_WfloatLlmGenerateResult)),
    ]
    lib.wfloat_llm_model_generate.restype = ctypes.c_int32

    lib.wfloat_llm_generate_result_destroy.argtypes = [
        ctypes.POINTER(_WfloatLlmGenerateResult)
    ]
    lib.wfloat_llm_generate_result_destroy.restype = None

    lib.wfloat_llm_model_format_chat.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_WfloatLlmChatTemplateOptions),
        ctypes.POINTER(ctypes.POINTER(_WfloatLlmChatTemplateResult)),
    ]
    lib.wfloat_llm_model_format_chat.restype = ctypes.c_int32

    lib.wfloat_llm_chat_template_result_destroy.argtypes = [
        ctypes.POINTER(_WfloatLlmChatTemplateResult)
    ]
    lib.wfloat_llm_chat_template_result_destroy.restype = None

    return lib


class CoreTts:
    def __init__(
        self,
        model_id: str,
        model_path: Path,
        tokens_path: Path,
        espeak_data_dir: Path,
    ) -> None:
        self._lib = _prepare_library(_load_core_library())
        self._model = ctypes.c_void_p()

        self._config_bytes = {
            "model_id": model_id.encode("utf-8"),
            "model_path": str(model_path).encode("utf-8"),
            "tokens_path": str(tokens_path).encode("utf-8"),
            "data_dir": str(espeak_data_dir).encode("utf-8"),
            "provider": DEFAULT_PROVIDER.encode("utf-8"),
        }

        config = _WfloatTtsModelConfig(
            model_id=self._config_bytes["model_id"],
            family=WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE,
            model_path=self._config_bytes["model_path"],
            tokens_path=self._config_bytes["tokens_path"],
            data_dir=self._config_bytes["data_dir"],
            lexicon_path=None,
            voices_path=None,
            lang=None,
            acoustic_model_path=None,
            vocoder_path=None,
            encoder_path=None,
            decoder_path=None,
            text_conditioner_path=None,
            lm_flow_path=None,
            lm_main_path=None,
            vocab_json_path=None,
            token_scores_json_path=None,
            num_threads=1,
            debug=0,
            provider=self._config_bytes["provider"],
            rule_fsts=None,
            rule_fars=None,
            max_num_sentences=1,
            silence_scale=0.2,
            noise_scale=0.667,
            noise_scale_w=0.8,
            length_scale=1.0,
            feat_scale=0.0,
            t_shift=0.0,
            target_rms=0.0,
            guidance_scale=0.0,
        )

        status = self._lib.wfloat_tts_model_create(
            ctypes.byref(config),
            ctypes.byref(self._model),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core model creation failed with status {status}.")

        info = _WfloatTtsModelInfo()
        status = self._lib.wfloat_tts_model_get_info(self._model, ctypes.byref(info))
        if status != WFLOAT_STATUS_OK:
            self.close()
            raise RuntimeError(f"wfloat-core model info failed with status {status}.")

        self.sample_rate = int(info.sample_rate)
        self.num_speakers = int(info.num_speakers)

    def close(self) -> None:
        if self._model and self._model.value:
            self._lib.wfloat_tts_model_destroy(self._model)
            self._model = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def synthesize_result(
        self,
        *,
        model_id: str,
        text: str,
        voice: Optional[object],
        sid: int,
        emotion: str,
        intensity: float,
        speed: float,
        silence_padding_sec: float,
    ) -> GenerationResult:
        text_bytes = text.encode("utf-8")
        voice_bytes = None if voice is None else str(voice).encode("utf-8")
        extra_entries_storage = [
            _WfloatStringMapEntry(b"emotion", emotion.encode("utf-8")),
            _WfloatStringMapEntry(b"intensity", str(float(intensity)).encode("utf-8")),
        ]
        extra_entries = (_WfloatStringMapEntry * len(extra_entries_storage))(
            *extra_entries_storage
        )
        options = _WfloatTtsSynthesizeOptions(
            text=text_bytes,
            voice=voice_bytes,
            sid=sid,
            speed=float(speed),
            silence_padding_sec=float(silence_padding_sec),
            reference_audio=None,
            reference_audio_sample_count=0,
            reference_audio_sample_rate=0,
            reference_text=None,
            num_steps=0,
            extra_entries=extra_entries,
            extra_entry_count=len(extra_entries_storage),
        )
        return self._run_synthesize(
            model_id=model_id,
            text=text,
            emotion=emotion,
            intensity=float(intensity),
            speed=float(speed),
            voice_by_segment={None: voice},
            defaults_by_segment={None: {"sid": sid, "emotion": emotion, "intensity": intensity, "speed": speed}},
            options=options,
        )

    def synthesize_dialogue_result(
        self,
        *,
        model_id: str,
        segments: Sequence[Dict[str, object]],
        silence_between_segments_sec: float,
    ) -> GenerationResult:
        segment_structs = []
        segment_buffers = []
        defaults_by_segment: Dict[Optional[int], Dict[str, object]] = {}
        voice_by_segment: Dict[Optional[int], Optional[object]] = {}

        for index, segment in enumerate(segments):
            text = str(segment["text"])
            voice = segment.get("voice_id")
            sid = int(segment["sid"])
            emotion = str(segment["emotion"])
            intensity = float(segment["intensity"])
            speed = float(segment["speed"])
            silence_padding_sec = float(segment["sentence_silence_padding_sec"])

            text_bytes = text.encode("utf-8")
            voice_bytes = None if voice is None else str(voice).encode("utf-8")
            extras_storage = [
                _WfloatStringMapEntry(b"emotion", emotion.encode("utf-8")),
                _WfloatStringMapEntry(b"intensity", str(intensity).encode("utf-8")),
            ]
            extras = (_WfloatStringMapEntry * len(extras_storage))(*extras_storage)

            segment_structs.append(
                _WfloatTtsDialogueSegment(
                    text=text_bytes,
                    voice=voice_bytes,
                    sid=sid,
                    speed=speed,
                    silence_padding_sec=silence_padding_sec,
                    extra_entries=extras,
                    extra_entry_count=len(extras_storage),
                )
            )
            segment_buffers.append((text_bytes, voice_bytes, extras_storage, extras))
            defaults_by_segment[index] = {
                "sid": sid,
                "emotion": emotion,
                "intensity": intensity,
                "speed": speed,
            }
            voice_by_segment[index] = voice

        segments_array = (_WfloatTtsDialogueSegment * len(segment_structs))(*segment_structs)
        options = _WfloatTtsDialogueOptions(
            segments=segments_array,
            segment_count=len(segment_structs),
            silence_between_segments_sec=float(silence_between_segments_sec),
        )

        return self._run_synthesize_dialogue(
            model_id=model_id,
            text="\n".join(str(segment["text"]) for segment in segments),
            voice_by_segment=voice_by_segment,
            defaults_by_segment=defaults_by_segment,
            options=options,
        )

    def _run_synthesize(
        self,
        *,
        model_id: str,
        text: str,
        emotion: str,
        intensity: float,
        speed: float,
        voice_by_segment: Dict[Optional[int], Optional[object]],
        defaults_by_segment: Dict[Optional[int], Dict[str, object]],
        options: _WfloatTtsSynthesizeOptions,
    ) -> GenerationResult:
        result_ptr = ctypes.POINTER(_WfloatTtsSynthesisResult)()
        status = self._lib.wfloat_tts_model_synthesize(
            self._model,
            ctypes.byref(options),
            None,
            None,
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core synthesize failed with status {status}.")

        try:
            return self._convert_result(
                model_id=model_id,
                fallback_text=text,
                voice_by_segment=voice_by_segment,
                defaults_by_segment=defaults_by_segment,
                result_ptr=result_ptr,
            )
        finally:
            self._lib.wfloat_tts_synthesis_result_destroy(result_ptr)

    def _run_synthesize_dialogue(
        self,
        *,
        model_id: str,
        text: str,
        voice_by_segment: Dict[Optional[int], Optional[object]],
        defaults_by_segment: Dict[Optional[int], Dict[str, object]],
        options: _WfloatTtsDialogueOptions,
    ) -> GenerationResult:
        result_ptr = ctypes.POINTER(_WfloatTtsSynthesisResult)()
        status = self._lib.wfloat_tts_model_synthesize_dialogue(
            self._model,
            ctypes.byref(options),
            None,
            None,
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(
                f"wfloat-core synthesize_dialogue failed with status {status}."
            )

        try:
            return self._convert_result(
                model_id=model_id,
                fallback_text=text,
                voice_by_segment=voice_by_segment,
                defaults_by_segment=defaults_by_segment,
                result_ptr=result_ptr,
            )
        finally:
            self._lib.wfloat_tts_synthesis_result_destroy(result_ptr)

    def _convert_result(
        self,
        *,
        model_id: str,
        fallback_text: str,
        voice_by_segment: Dict[Optional[int], Optional[object]],
        defaults_by_segment: Dict[Optional[int], Dict[str, object]],
        result_ptr: ctypes.POINTER(_WfloatTtsSynthesisResult),
    ) -> GenerationResult:
        result = result_ptr.contents
        audio_samples = [
            float(result.audio.samples[index]) for index in range(int(result.audio.sample_count))
        ]
        audio = Audio(
            samples=audio_samples,
            sample_rate=int(result.audio.sample_rate),
        )

        timeline_chunks: List[TimelineChunk] = []
        for index in range(int(result.timeline.chunk_count)):
            chunk = result.timeline.chunks[index]
            segment_index = int(chunk.segment_index)
            if segment_index < 0:
                segment_index = None

            defaults = defaults_by_segment.get(segment_index, defaults_by_segment.get(None, {}))
            timeline_chunks.append(
                TimelineChunk(
                    index=int(chunk.index),
                    text=_decode(chunk.text),
                    highlight_start=int(chunk.highlight_start),
                    highlight_end=int(chunk.highlight_end),
                    start_sec=float(chunk.start_sec),
                    end_sec=float(chunk.end_sec),
                    duration_sec=float(chunk.duration_sec),
                    progress=float(chunk.progress),
                    voice_id=voice_by_segment.get(segment_index, voice_by_segment.get(None)),
                    sid=int(defaults.get("sid", chunk.sid)),
                    emotion=str(defaults.get("emotion", "neutral")),
                    intensity=float(defaults.get("intensity", DEFAULT_INTENSITY)),
                    speed=float(defaults.get("speed", DEFAULT_SPEED)),
                    segment_index=segment_index,
                )
            )

        timeline = Timeline(
            chunks=timeline_chunks,
            duration_sec=float(result.timeline.duration_sec or audio.duration_sec),
        )
        return GenerationResult(
            audio=audio,
            timeline=timeline,
            text=_decode(result.text) or fallback_text,
            model_name=_decode(result.model_id) or model_id,
        )


def create_core_tts(
    model_name: str,
    model_path: Path,
    tokens_path: Path,
    espeak_data_dir: Path,
):
    return CoreTts(
        model_id=model_name,
        model_path=model_path,
        tokens_path=tokens_path,
        espeak_data_dir=espeak_data_dir,
    )


class CoreStt:
    def __init__(
        self,
        *,
        model_id: str,
        family: int,
        model_path: Optional[Path],
        tokens_path: Path,
        preprocessor_path: Optional[Path] = None,
        encoder_path: Optional[Path] = None,
        decoder_path: Optional[Path] = None,
        joiner_path: Optional[Path] = None,
        uncached_decoder_path: Optional[Path] = None,
        cached_decoder_path: Optional[Path] = None,
        language: Optional[str] = None,
        task: Optional[str] = None,
        enable_token_timestamps: bool = False,
        enable_segment_timestamps: bool = False,
    ) -> None:
        self._lib = _prepare_library(_load_core_library())
        self._model = ctypes.c_void_p()

        self._config_bytes = {
            "model_id": model_id.encode("utf-8"),
            "model_path": None if model_path is None else str(model_path).encode("utf-8"),
            "tokens_path": str(tokens_path).encode("utf-8"),
            "preprocessor_path": None
            if preprocessor_path is None
            else str(preprocessor_path).encode("utf-8"),
            "encoder_path": None if encoder_path is None else str(encoder_path).encode("utf-8"),
            "decoder_path": None if decoder_path is None else str(decoder_path).encode("utf-8"),
            "joiner_path": None if joiner_path is None else str(joiner_path).encode("utf-8"),
            "uncached_decoder_path": None
            if uncached_decoder_path is None
            else str(uncached_decoder_path).encode("utf-8"),
            "cached_decoder_path": None
            if cached_decoder_path is None
            else str(cached_decoder_path).encode("utf-8"),
            "provider": DEFAULT_PROVIDER.encode("utf-8"),
            "language": None if language is None else language.encode("utf-8"),
            "task": None if task is None else task.encode("utf-8"),
        }

        config = _WfloatSttModelConfig(
            model_id=self._config_bytes["model_id"],
            family=family,
            model_path=self._config_bytes["model_path"],
            tokens_path=self._config_bytes["tokens_path"],
            preprocessor_path=self._config_bytes["preprocessor_path"],
            encoder_path=self._config_bytes["encoder_path"],
            decoder_path=self._config_bytes["decoder_path"],
            joiner_path=self._config_bytes["joiner_path"],
            uncached_decoder_path=self._config_bytes["uncached_decoder_path"],
            cached_decoder_path=self._config_bytes["cached_decoder_path"],
            provider=self._config_bytes["provider"],
            language=self._config_bytes["language"],
            task=self._config_bytes["task"],
            hotwords_file=None,
            rule_fsts=None,
            rule_fars=None,
            sample_rate=16000,
            feat_dim=80,
            num_threads=1,
            debug=0,
            max_active_paths=4,
            tail_paddings=0,
            enable_token_timestamps=1 if enable_token_timestamps else 0,
            enable_segment_timestamps=1 if enable_segment_timestamps else 0,
            hotwords_score=1.5,
            blank_penalty=0.0,
        )

        status = self._lib.wfloat_stt_model_create(
            ctypes.byref(config),
            ctypes.byref(self._model),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core STT model creation failed with status {status}.")

        info = _WfloatSttModelInfo()
        status = self._lib.wfloat_stt_model_get_info(self._model, ctypes.byref(info))
        if status != WFLOAT_STATUS_OK:
            self.close()
            raise RuntimeError(f"wfloat-core STT model info failed with status {status}.")

        self.sample_rate = int(info.sample_rate)
        self.supports_language_override = bool(info.supports_language_override)

    def close(self) -> None:
        if self._model and self._model.value:
            self._lib.wfloat_stt_model_destroy(self._model)
            self._model = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def transcribe_result(
        self,
        *,
        model_id: str,
        samples: Sequence[float],
        sample_rate: int,
        language: Optional[str] = None,
        task: Optional[str] = None,
        hotwords: Optional[str] = None,
    ) -> TranscriptionResult:
        sample_values = [float(sample) for sample in samples]
        sample_array = (ctypes.c_float * len(sample_values))(*sample_values)
        language_bytes = None if language is None else language.encode("utf-8")
        task_bytes = None if task is None else task.encode("utf-8")
        hotwords_bytes = None if hotwords is None else hotwords.encode("utf-8")

        options = _WfloatSttTranscribeOptions(
            samples=sample_array,
            sample_count=len(sample_values),
            sample_rate=int(sample_rate),
            language=language_bytes,
            task=task_bytes,
            hotwords=hotwords_bytes,
        )

        result_ptr = ctypes.POINTER(_WfloatSttTranscriptionResult)()
        status = self._lib.wfloat_stt_model_transcribe(
            self._model,
            ctypes.byref(options),
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core transcribe failed with status {status}.")

        try:
            result = result_ptr.contents
            tokens = [
                TranscriptionToken(
                    text=_decode(result.tokens[index].text),
                    start_sec=float(result.tokens[index].start_sec),
                    duration_sec=float(result.tokens[index].duration_sec),
                    confidence=float(result.tokens[index].confidence),
                )
                for index in range(int(result.token_count))
            ]
            segments = [
                TranscriptionSegment(
                    text=_decode(result.segments[index].text),
                    start_sec=float(result.segments[index].start_sec),
                    duration_sec=float(result.segments[index].duration_sec),
                )
                for index in range(int(result.segment_count))
            ]

            return TranscriptionResult(
                text=_decode(result.text),
                model_id=_decode(result.model_id) or model_id,
                language=_decode(result.language),
                emotion=_decode(result.emotion),
                event=_decode(result.event),
                json=_decode(result.json),
                tokens=tokens or None,
                segments=segments or None,
            )
        finally:
            self._lib.wfloat_stt_transcription_result_destroy(result_ptr)

    def create_session(self):
        session = ctypes.c_void_p()
        status = self._lib.wfloat_stt_model_create_session(
            self._model,
            ctypes.byref(session),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core create_session failed with status {status}.")

        return CoreSttSession(
            lib=self._lib,
            model_id=_decode(self._config_bytes["model_id"]),
            session=session,
            sample_rate=self.sample_rate,
        )


class CoreSttSession:
    def __init__(
        self,
        *,
        lib: ctypes.CDLL,
        model_id: str,
        session: ctypes.c_void_p,
        sample_rate: int,
    ) -> None:
        self._lib = lib
        self._model_id = model_id
        self._session = session
        self.sample_rate = int(sample_rate)

    def close(self) -> None:
        if self._session and self._session.value:
            self._lib.wfloat_stt_session_destroy(self._session)
            self._session = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def push(self, samples: Sequence[float], sample_rate: Optional[int] = None) -> None:
        sample_values = [float(sample) for sample in samples]
        if not sample_values:
            raise ValueError("samples must not be empty.")

        resolved_sample_rate = int(sample_rate or self.sample_rate)
        sample_array = (ctypes.c_float * len(sample_values))(*sample_values)
        status = self._lib.wfloat_stt_session_push_audio(
            self._session,
            sample_array,
            len(sample_values),
            resolved_sample_rate,
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core session push failed with status {status}.")

    def get_result(self) -> StreamingTranscriptionResult:
        result_ptr = ctypes.POINTER(_WfloatSttSessionResult)()
        status = self._lib.wfloat_stt_session_get_result(
            self._session,
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(
                f"wfloat-core session get_result failed with status {status}."
            )

        try:
            result = result_ptr.contents
            return StreamingTranscriptionResult(
                text=_decode(result.text),
                model_id=_decode(result.model_id) or self._model_id,
                is_endpoint=bool(result.is_endpoint),
                json=_decode(result.json),
            )
        finally:
            self._lib.wfloat_stt_session_result_destroy(result_ptr)

    def finish(self) -> StreamingTranscriptionResult:
        result_ptr = ctypes.POINTER(_WfloatSttSessionResult)()
        status = self._lib.wfloat_stt_session_finish(
            self._session,
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core session finish failed with status {status}.")

        try:
            result = result_ptr.contents
            return StreamingTranscriptionResult(
                text=_decode(result.text),
                model_id=_decode(result.model_id) or self._model_id,
                is_endpoint=bool(result.is_endpoint),
                json=_decode(result.json),
            )
        finally:
            self._lib.wfloat_stt_session_result_destroy(result_ptr)

    def reset(self) -> None:
        status = self._lib.wfloat_stt_session_reset(self._session)
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core session reset failed with status {status}.")


def create_core_stt_whisper(
    *,
    model_name: str,
    encoder_path: Path,
    decoder_path: Path,
    tokens_path: Path,
    language: Optional[str] = None,
    task: Optional[str] = None,
    enable_token_timestamps: bool = False,
    enable_segment_timestamps: bool = False,
):
    return CoreStt(
        model_id=model_name,
        family=WFLOAT_STT_FAMILY_WHISPER,
        model_path=None,
        tokens_path=tokens_path,
        encoder_path=encoder_path,
        decoder_path=decoder_path,
        language=language,
        task=task,
        enable_token_timestamps=enable_token_timestamps,
        enable_segment_timestamps=enable_segment_timestamps,
    )


def create_core_stt(
    *,
    model_name: str,
    family: str,
    model_path: Optional[Path],
    tokens_path: Path,
    preprocessor_path: Optional[Path] = None,
    encoder_path: Optional[Path] = None,
    decoder_path: Optional[Path] = None,
    joiner_path: Optional[Path] = None,
    uncached_decoder_path: Optional[Path] = None,
    cached_decoder_path: Optional[Path] = None,
    language: Optional[str] = None,
    task: Optional[str] = None,
    enable_token_timestamps: bool = False,
    enable_segment_timestamps: bool = False,
):
    normalized_family = family.strip().lower().replace("_", "-")
    family_map = {
        "whisper": WFLOAT_STT_FAMILY_WHISPER,
        "moonshine": WFLOAT_STT_FAMILY_MOONSHINE,
        "parakeet-ctc": WFLOAT_STT_FAMILY_PARAKEET_CTC,
        "parakeet-tdt": WFLOAT_STT_FAMILY_PARAKEET_TDT,
        "zipformer-transducer": WFLOAT_STT_FAMILY_ZIPFORMER_TRANSDUCER,
    }
    family_value = family_map.get(normalized_family)
    if family_value is None:
        raise ValueError(f"Unsupported STT family: {family}")

    return CoreStt(
        model_id=model_name,
        family=family_value,
        model_path=model_path,
        tokens_path=tokens_path,
        preprocessor_path=preprocessor_path,
        encoder_path=encoder_path,
        decoder_path=decoder_path,
        joiner_path=joiner_path,
        uncached_decoder_path=uncached_decoder_path,
        cached_decoder_path=cached_decoder_path,
        language=language,
        task=task,
        enable_token_timestamps=enable_token_timestamps,
        enable_segment_timestamps=enable_segment_timestamps,
    )


class _CoreVadNativeSegment:
    def __init__(self, *, start: int, samples: Sequence[float]) -> None:
        self.start = int(start)
        self.samples = list(samples)


class CoreVad:
    def __init__(
        self,
        *,
        model_id: str,
        family: int,
        model_path: Path,
        threshold: float,
        min_silence_duration_sec: float,
        min_speech_duration_sec: float,
        max_speech_duration_sec: float,
        sample_rate: int,
        window_size: int,
        buffer_size_in_seconds: float,
    ) -> None:
        self._lib = _prepare_library(_load_core_library())
        self._model = ctypes.c_void_p()
        self._config_bytes = {
            "model_id": model_id.encode("utf-8"),
            "model_path": str(model_path).encode("utf-8"),
            "provider": DEFAULT_PROVIDER.encode("utf-8"),
        }

        config = _WfloatVadModelConfig(
            model_id=self._config_bytes["model_id"],
            family=family,
            model_path=self._config_bytes["model_path"],
            threshold=float(threshold),
            min_silence_duration_sec=float(min_silence_duration_sec),
            min_speech_duration_sec=float(min_speech_duration_sec),
            max_speech_duration_sec=float(max_speech_duration_sec),
            sample_rate=int(sample_rate),
            window_size=int(window_size),
            num_threads=1,
            provider=self._config_bytes["provider"],
            debug=0,
            buffer_size_in_seconds=float(buffer_size_in_seconds),
        )

        status = self._lib.wfloat_vad_model_create(
            ctypes.byref(config),
            ctypes.byref(self._model),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD model creation failed with status {status}.")

        info = _WfloatVadModelInfo()
        status = self._lib.wfloat_vad_model_get_info(self._model, ctypes.byref(info))
        if status != WFLOAT_STATUS_OK:
            self.close()
            raise RuntimeError(f"wfloat-core VAD model info failed with status {status}.")

        self.sample_rate = int(info.sample_rate)
        self.window_size = int(info.window_size)

    def close(self) -> None:
        if self._model and self._model.value:
            self._lib.wfloat_vad_model_destroy(self._model)
            self._model = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def reset(self) -> None:
        status = self._lib.wfloat_vad_model_reset(self._model)
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD reset failed with status {status}.")

    def accept_waveform(self, samples: Sequence[float]) -> None:
        sample_values = [float(sample) for sample in samples]
        if not sample_values:
            return

        sample_array = (ctypes.c_float * len(sample_values))(*sample_values)
        status = self._lib.wfloat_vad_model_accept_waveform(
            self._model,
            sample_array,
            len(sample_values),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(
                f"wfloat-core VAD accept_waveform failed with status {status}."
            )

    def flush(self) -> None:
        status = self._lib.wfloat_vad_model_flush(self._model)
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD flush failed with status {status}.")

    def empty(self) -> bool:
        value = ctypes.c_int32()
        status = self._lib.wfloat_vad_model_empty(self._model, ctypes.byref(value))
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD empty failed with status {status}.")
        return bool(value.value)

    def detected(self) -> bool:
        value = ctypes.c_int32()
        status = self._lib.wfloat_vad_model_detected(self._model, ctypes.byref(value))
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD detected failed with status {status}.")
        return bool(value.value)

    @property
    def front(self) -> _CoreVadNativeSegment:
        segment_ptr = ctypes.POINTER(_WfloatVadSegment)()
        status = self._lib.wfloat_vad_model_front(
            self._model,
            ctypes.byref(segment_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD front failed with status {status}.")

        try:
            segment = segment_ptr.contents
            samples = [
                float(segment.samples[index])
                for index in range(int(segment.sample_count))
            ]
            return _CoreVadNativeSegment(
                start=int(segment.start_sample),
                samples=samples,
            )
        finally:
            self._lib.wfloat_vad_segment_destroy(segment_ptr)

    def pop(self) -> None:
        status = self._lib.wfloat_vad_model_pop(self._model)
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD pop failed with status {status}.")

    def clear(self) -> None:
        status = self._lib.wfloat_vad_model_clear(self._model)
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core VAD clear failed with status {status}.")


def create_core_vad(
    *,
    model_name: str,
    family: str,
    model_path: Path,
    threshold: float,
    min_silence_duration_sec: float,
    min_speech_duration_sec: float,
    max_speech_duration_sec: float,
    sample_rate: int,
    buffer_size_in_seconds: float,
):
    normalized_family = family.strip().lower().replace("_", "-")
    family_map = {
        "silero": WFLOAT_VAD_FAMILY_SILERO,
        "silero-vad": WFLOAT_VAD_FAMILY_SILERO,
        "ten-vad": WFLOAT_VAD_FAMILY_TEN,
        "tenvad": WFLOAT_VAD_FAMILY_TEN,
    }
    family_value = family_map.get(normalized_family)
    if family_value is None:
        raise ValueError(f"Unsupported VAD family: {family}")

    window_size = 256 if family_value == WFLOAT_VAD_FAMILY_TEN else 512
    return CoreVad(
        model_id=model_name,
        family=family_value,
        model_path=model_path,
        threshold=threshold,
        min_silence_duration_sec=min_silence_duration_sec,
        min_speech_duration_sec=min_speech_duration_sec,
        max_speech_duration_sec=max_speech_duration_sec,
        sample_rate=sample_rate,
        window_size=window_size,
        buffer_size_in_seconds=buffer_size_in_seconds,
    )


class CoreLlm:
    def __init__(
        self,
        *,
        model_id: str,
        family: int,
        model_path: Path,
        context_size: int = 2048,
        num_threads: int = 1,
        gpu_layer_count: int = 0,
        chat_template: Optional[str] = None,
    ) -> None:
        self._lib = _prepare_library(_load_core_library())
        self._model = ctypes.c_void_p()

        self._config_bytes = {
            "model_id": model_id.encode("utf-8"),
            "model_path": str(model_path).encode("utf-8"),
            "chat_template": None
            if chat_template is None
            else chat_template.encode("utf-8"),
            "provider": b"llama.cpp",
        }

        config = _WfloatLlmModelConfig(
            model_id=self._config_bytes["model_id"],
            family=family,
            model_path=self._config_bytes["model_path"],
            chat_template=self._config_bytes["chat_template"],
            provider=self._config_bytes["provider"],
            context_size=int(context_size),
            num_threads=int(num_threads),
            gpu_layer_count=int(gpu_layer_count),
            seed=0,
        )

        status = self._lib.wfloat_llm_model_create(
            ctypes.byref(config),
            ctypes.byref(self._model),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core LLM model creation failed with status {status}.")

        info = _WfloatLlmModelInfo()
        status = self._lib.wfloat_llm_model_get_info(self._model, ctypes.byref(info))
        if status != WFLOAT_STATUS_OK:
            self.close()
            raise RuntimeError(f"wfloat-core LLM model info failed with status {status}.")

        self.model_id = _decode(info.model_id) or model_id
        self.backend = _decode(info.backend)
        self.family = _decode(info.family)
        self.context_size = int(info.context_size)

    def close(self) -> None:
        if self._model and self._model.value:
            self._lib.wfloat_llm_model_destroy(self._model)
            self._model = ctypes.c_void_p()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 128,
        temperature: float = 0.8,
        top_p: float = 0.95,
        top_k: int = 40,
        repeat_penalty: float = 1.0,
        seed: int = 0,
        on_token=None,
    ) -> LlmGenerationResult:
        prompt_bytes = prompt.encode("utf-8")
        options = _WfloatLlmGenerateOptions(
            prompt=prompt_bytes,
            max_tokens=int(max_tokens),
            temperature=float(temperature),
            top_p=float(top_p),
            top_k=int(top_k),
            repeat_penalty=float(repeat_penalty),
            seed=int(seed),
        )

        callback_ref = _WfloatLlmTokenCallback(
            lambda event, _user_data: self._handle_token(event, on_token)
        )
        result_ptr = ctypes.POINTER(_WfloatLlmGenerateResult)()
        status = self._lib.wfloat_llm_model_generate(
            self._model,
            ctypes.byref(options),
            callback_ref,
            None,
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core LLM generate failed with status {status}.")

        try:
            result = result_ptr.contents
            return LlmGenerationResult(
                text=_decode(result.text),
                model_id=_decode(result.model_id) or self.model_id,
                finish_reason=_decode(result.finish_reason),
                json=_decode(result.json),
                prompt_token_count=int(result.prompt_token_count),
                completion_token_count=int(result.completion_token_count),
            )
        finally:
            self._lib.wfloat_llm_generate_result_destroy(result_ptr)

    def format_chat(
        self,
        messages: Sequence[Dict[str, str]],
        *,
        add_generation_prompt: bool = True,
    ) -> str:
        message_structs = []
        message_buffers = []
        for message in messages:
            role = str(message["role"])
            content = str(message["content"])
            role_bytes = role.encode("utf-8")
            content_bytes = content.encode("utf-8")
            message_buffers.append((role_bytes, content_bytes))
            message_structs.append(
                _WfloatLlmChatMessage(
                    role=role_bytes,
                    content=content_bytes,
                )
            )

        if not message_structs:
            raise ValueError("LLM chat messages cannot be empty.")

        message_array = (_WfloatLlmChatMessage * len(message_structs))(
            *message_structs
        )
        options = _WfloatLlmChatTemplateOptions(
            messages=message_array,
            message_count=len(message_structs),
            add_generation_prompt=1 if add_generation_prompt else 0,
        )
        result_ptr = ctypes.POINTER(_WfloatLlmChatTemplateResult)()
        status = self._lib.wfloat_llm_model_format_chat(
            self._model,
            ctypes.byref(options),
            ctypes.byref(result_ptr),
        )
        if status != WFLOAT_STATUS_OK:
            raise RuntimeError(f"wfloat-core LLM format_chat failed with status {status}.")

        try:
            result = result_ptr.contents
            if result.used_fallback:
                warnings.warn(
                    "wfloat-core could not apply this GGUF model's chat "
                    "template with llama.cpp, so it used a generic fallback "
                    "prompt format. Output quality may be degraded.",
                    RuntimeWarning,
                    stacklevel=2,
                )
            return _decode(result.prompt)
        finally:
            self._lib.wfloat_llm_chat_template_result_destroy(result_ptr)

    def chat(
        self,
        messages: Sequence[Dict[str, str]],
        *,
        max_tokens: int = 128,
        temperature: float = 0.8,
        top_p: float = 0.95,
        top_k: int = 40,
        repeat_penalty: float = 1.0,
        seed: int = 0,
        on_token=None,
    ) -> LlmGenerationResult:
        prompt = self.format_chat(messages, add_generation_prompt=True)
        return self.generate(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
            seed=seed,
            on_token=on_token,
        )

    @staticmethod
    def _handle_token(event_ptr, on_token) -> int:
        if on_token is None:
            return 0

        event = event_ptr.contents
        if event.is_done:
            return 0

        on_token(_decode(event.text))
        return 0


def create_core_llm(
    *,
    model_name: str,
    family: str,
    model_path: Path,
    context_size: int = 2048,
    num_threads: int = 1,
    gpu_layer_count: int = 0,
    chat_template: Optional[str] = None,
):
    normalized_family = family.strip().lower().replace("_", "-")
    family_map = {
        "llama": WFLOAT_LLM_FAMILY_LLAMA,
        "qwen": WFLOAT_LLM_FAMILY_QWEN,
        "qwen2": WFLOAT_LLM_FAMILY_QWEN,
        "qwen3": WFLOAT_LLM_FAMILY_QWEN,
        "smollm": WFLOAT_LLM_FAMILY_SMOLLM,
        "smollm2": WFLOAT_LLM_FAMILY_SMOLLM,
        "gemma": WFLOAT_LLM_FAMILY_GEMMA,
        "mistral": WFLOAT_LLM_FAMILY_MISTRAL,
        "phi": WFLOAT_LLM_FAMILY_PHI,
        "liquid": WFLOAT_LLM_FAMILY_LIQUID,
        "lfm": WFLOAT_LLM_FAMILY_LIQUID,
        "lfm2": WFLOAT_LLM_FAMILY_LIQUID,
    }
    family_value = family_map.get(normalized_family)
    if family_value is None:
        raise ValueError(f"Unsupported LLM family: {family}")

    return CoreLlm(
        model_id=model_name,
        family=family_value,
        model_path=model_path,
        context_size=context_size,
        num_threads=num_threads,
        gpu_layer_count=gpu_layer_count,
        chat_template=chat_template,
    )

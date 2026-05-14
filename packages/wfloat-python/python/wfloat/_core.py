import ctypes
import os
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from ._constants import (
    DEFAULT_INTENSITY,
    DEFAULT_PROVIDER,
    DEFAULT_SPEED,
)
from ._results import Audio, GenerationResult, Timeline, TimelineChunk

WFLOAT_TTS_FAMILY_WFLOAT_EXPRESSIVE = 1
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


class _CoreLibraryError(ImportError):
    pass


def _decode(value: Optional[bytes]) -> str:
    return value.decode("utf-8") if value else ""


def _iter_candidate_library_paths() -> Sequence[Path]:
    env_path = os.environ.get("WFLOAT_CORE_LIBRARY")
    if env_path:
        return [Path(env_path)]

    repo_root = Path(__file__).resolve().parents[4]
    candidates: List[Path] = []
    for pattern in (
        "build/**/libwfloat-core.so",
        "build/**/libwfloat-core.dylib",
        "build/**/wfloat-core.dll",
    ):
        candidates.extend(repo_root.glob(pattern))

    return candidates


def _load_core_library() -> ctypes.CDLL:
    errors: List[str] = []

    for candidate in _iter_candidate_library_paths():
        try:
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

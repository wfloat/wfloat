from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ._assets import fetch_model_assets
from ._cache import (
    CachedModelAssets,
    cache_model_assets,
)
from ._constants import (
    DEFAULT_MODEL_NAME,
    DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC,
    normalize_emotion,
    normalize_intensity,
    normalize_silence_padding_sec,
    normalize_speed,
    normalize_text,
    normalize_voice_id,
)
from ._native import create_native_tts
from ._results import Audio, GenerationResult, Timeline, TimelineChunk


@dataclass
class _PreparedChunk:
    text: str
    text_clean: str
    highlight_start: int
    highlight_end: int
    sid: int
    voice_id: Optional[object]
    emotion: str
    intensity: float
    speed: float
    silence_padding_sec: float
    segment_index: Optional[int]


class Model:
    def __init__(
        self,
        model_name: str,
        native_tts,
        *,
        cached_assets: Optional[CachedModelAssets] = None,
    ) -> None:
        self.model_name = model_name
        self._native_tts = native_tts
        self._cached_assets = cached_assets

    @property
    def sample_rate(self) -> int:
        return int(self._native_tts.sample_rate)

    @property
    def num_speakers(self) -> int:
        return int(self._native_tts.num_speakers)

    def __repr__(self) -> str:
        return "Model(model_name=%r, sample_rate=%r, num_speakers=%r)" % (
            self.model_name,
            self.sample_rate,
            self.num_speakers,
        )

    def generate(
        self,
        *,
        text: str,
        voice_id=None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        speed: Optional[float] = None,
        silence_padding_sec: Optional[float] = None,
    ) -> GenerationResult:
        normalized_text = normalize_text(text)
        normalized_emotion = normalize_emotion(emotion)
        normalized_intensity = normalize_intensity(intensity)
        normalized_speed = normalize_speed(speed)
        normalized_silence_padding_sec = normalize_silence_padding_sec(
            silence_padding_sec
        )
        normalized_voice_id = voice_id
        sid = normalize_voice_id(voice_id)

        if hasattr(self._native_tts, "synthesize_result"):
            return self._native_tts.synthesize_result(
                model_id=self.model_name,
                text=normalized_text,
                voice=normalized_voice_id,
                sid=sid,
                emotion=normalized_emotion,
                intensity=normalized_intensity,
                speed=normalized_speed,
                silence_padding_sec=normalized_silence_padding_sec,
            )

        prepared = self._native_tts.prepare_wfloat_text(
            normalized_text,
            normalized_emotion,
            normalized_intensity,
        )
        prepared_chunks = self._build_prepared_chunks(
            prepared.text,
            prepared.text_clean,
            sid=sid,
            voice_id=voice_id,
            emotion=normalized_emotion,
            intensity=normalized_intensity,
            speed=normalized_speed,
            silence_padding_sec=normalized_silence_padding_sec,
            segment_index=None,
        )

        result = self._synthesize_chunks(
            prepared_chunks,
            result_text=normalized_text,
        )
        return result

    def synthesize(
        self,
        *,
        text: str,
        voice: Optional[object] = None,
        speed: Optional[float] = None,
        emotion: Optional[str] = None,
        intensity: Optional[float] = None,
        silence_padding_sec: Optional[float] = None,
    ) -> GenerationResult:
        return self.generate(
            text=text,
            voice_id=voice,
            emotion=emotion,
            intensity=intensity,
            speed=speed,
            silence_padding_sec=silence_padding_sec,
        )

    def generate_dialogue(
        self,
        *,
        segments: Sequence[Mapping[str, Any]],
        speed: Optional[float] = None,
        silence_between_segments_sec: Optional[float] = None,
    ) -> GenerationResult:
        if not segments:
            raise ValueError("segments is required.")

        default_speed = normalize_speed(speed)
        dialogue_silence_sec = normalize_silence_padding_sec(
            silence_between_segments_sec,
            default=DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC,
        )

        if hasattr(self._native_tts, "synthesize_dialogue_result"):
            normalized_segments = []
            for segment in segments:
                if not isinstance(segment, Mapping):
                    raise TypeError("Each segment must be a mapping.")

                normalized_segments.append(
                    self._normalize_dialogue_segment(
                        segment,
                        default_speed=default_speed,
                    )
                )

            return self._native_tts.synthesize_dialogue_result(
                model_id=self.model_name,
                segments=normalized_segments,
                silence_between_segments_sec=dialogue_silence_sec,
            )

        prepared_chunks = []
        dialogue_texts = []

        for segment_index, segment in enumerate(segments):
            if not isinstance(segment, Mapping):
                raise TypeError("Each segment must be a mapping.")

            normalized_segment = self._normalize_dialogue_segment(
                segment,
                default_speed=default_speed,
            )
            dialogue_texts.append(normalized_segment["text"])

            prepared = self._native_tts.prepare_wfloat_text(
                normalized_segment["text"],
                normalized_segment["emotion"],
                normalized_segment["intensity"],
            )
            segment_chunks = self._build_prepared_chunks(
                prepared.text,
                prepared.text_clean,
                sid=normalized_segment["sid"],
                voice_id=normalized_segment["voice_id"],
                emotion=normalized_segment["emotion"],
                intensity=normalized_segment["intensity"],
                speed=normalized_segment["speed"],
                silence_padding_sec=normalized_segment["sentence_silence_padding_sec"],
                segment_index=segment_index,
            )
            prepared_chunks.extend(segment_chunks)

            if segment_index < len(segments) - 1 and segment_chunks:
                prepared_chunks[-1].silence_padding_sec = dialogue_silence_sec

        return self._synthesize_chunks(
            prepared_chunks,
            result_text=" ".join(dialogue_texts),
        )

    def synthesize_dialogue(
        self,
        *,
        segments: Sequence[Mapping[str, Any]],
        speed: Optional[float] = None,
        silence_between_segments_sec: Optional[float] = None,
    ) -> GenerationResult:
        return self.generate_dialogue(
            segments=segments,
            speed=speed,
            silence_between_segments_sec=silence_between_segments_sec,
        )

    def _normalize_dialogue_segment(
        self,
        segment: Mapping[str, Any],
        *,
        default_speed: float,
    ) -> Dict[str, Any]:
        text = normalize_text(segment.get("text"))  # type: ignore[arg-type]
        voice_id = segment.get("voice", segment.get("voice_id"))
        emotion = normalize_emotion(segment.get("emotion"))
        intensity = normalize_intensity(segment.get("intensity"))
        speed = normalize_speed(segment.get("speed"), default=default_speed)
        sentence_silence_padding_sec = normalize_silence_padding_sec(
            segment.get("sentence_silence_padding_sec")
        )
        sid = normalize_voice_id(voice_id)

        return {
            "text": text,
            "voice_id": voice_id,
            "emotion": emotion,
            "intensity": intensity,
            "speed": speed,
            "sentence_silence_padding_sec": sentence_silence_padding_sec,
            "sid": sid,
        }

    def _build_prepared_chunks(
        self,
        raw_text_chunks: Sequence[str],
        clean_text_chunks: Sequence[str],
        *,
        sid: int,
        voice_id,
        emotion: str,
        intensity: float,
        speed: float,
        silence_padding_sec: float,
        segment_index: Optional[int],
    ) -> List[_PreparedChunk]:
        chunks = []
        raw_cursor = 0
        for index, raw_chunk_text in enumerate(raw_text_chunks):
            highlight_start = raw_cursor
            highlight_end = raw_cursor + len(raw_chunk_text)
            raw_cursor = highlight_end

            chunks.append(
                _PreparedChunk(
                    text=raw_chunk_text,
                    text_clean=clean_text_chunks[index],
                    highlight_start=highlight_start,
                    highlight_end=highlight_end,
                    sid=sid,
                    voice_id=voice_id,
                    emotion=emotion,
                    intensity=intensity,
                    speed=speed,
                    silence_padding_sec=silence_padding_sec,
                    segment_index=segment_index,
                )
            )
        return chunks

    def _synthesize_chunks(
        self,
        chunks: Sequence[_PreparedChunk],
        *,
        result_text: str,
    ) -> GenerationResult:
        if not chunks:
            raise RuntimeError("Text preparation produced no synthesizeable chunks.")

        all_samples = []
        timeline_chunks = []
        total_chunks = len(chunks)
        cumulative_samples = 0
        sample_rate = self.sample_rate

        for index, chunk in enumerate(chunks):
            generated_audio = self._native_tts.generate(
                chunk.text_clean,
                chunk.sid,
                chunk.speed,
            )
            chunk_samples = [float(sample) for sample in generated_audio.samples]
            chunk_sample_rate = int(generated_audio.sample_rate)
            if chunk_sample_rate <= 0:
                raise RuntimeError("Native generation returned an invalid sample rate.")

            if index == 0:
                sample_rate = chunk_sample_rate
            elif chunk_sample_rate != sample_rate:
                raise RuntimeError(
                    "Native generation returned inconsistent sample rates across chunks."
                )

            start_sec = cumulative_samples / float(sample_rate)
            all_samples.extend(chunk_samples)
            cumulative_samples += len(chunk_samples)
            end_sec = cumulative_samples / float(sample_rate)

            timeline_chunks.append(
                TimelineChunk(
                    index=index,
                    text=chunk.text,
                    highlight_start=chunk.highlight_start,
                    highlight_end=chunk.highlight_end,
                    start_sec=start_sec,
                    end_sec=end_sec,
                    duration_sec=end_sec - start_sec,
                    progress=float(index + 1) / float(total_chunks),
                    voice_id=chunk.voice_id,
                    sid=chunk.sid,
                    emotion=chunk.emotion,
                    intensity=chunk.intensity,
                    speed=chunk.speed,
                    segment_index=chunk.segment_index,
                )
            )

            if index < total_chunks - 1 and chunk.silence_padding_sec > 0:
                silence_samples = int(round(chunk.silence_padding_sec * sample_rate))
                if silence_samples > 0:
                    all_samples.extend([0.0] * silence_samples)
                    cumulative_samples += silence_samples

        audio = Audio(samples=all_samples, sample_rate=sample_rate)
        timeline = Timeline(chunks=timeline_chunks, duration_sec=audio.duration_sec)
        result = GenerationResult(
            audio=audio,
            timeline=timeline,
            text=result_text,
            model_name=self.model_name,
        )

        return result


def load(
    model_name: str = DEFAULT_MODEL_NAME,
    *,
    cache_dir=None,
    force_download: bool = False,
) -> Model:
    normalized_model_name = normalize_text(model_name)
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else None
    assets = fetch_model_assets(normalized_model_name)
    cached_assets = cache_model_assets(
        normalized_model_name,
        assets,
        cache_dir=resolved_cache_dir,
        force_download=force_download,
    )
    native_tts = create_native_tts(
        normalized_model_name,
        cached_assets.model_path,
        cached_assets.tokens_path,
        cached_assets.espeak_data_dir,
    )
    return Model(
        normalized_model_name,
        native_tts,
        cached_assets=cached_assets,
    )


TtsModel = Model
load_tts_model = load

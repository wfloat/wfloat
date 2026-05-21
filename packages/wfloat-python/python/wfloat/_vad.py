from __future__ import annotations

import math
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from ._results import Audio, VadDetectionResult, VadSegment

DEFAULT_VAD_SAMPLE_RATE = 16000


def _coerce_audio_samples(audio: bytes | Sequence[float]) -> list[float]:
    if isinstance(audio, (bytes, bytearray, memoryview)):
        raise TypeError(
            "Raw PCM bytes are not supported yet. Pass a float sequence or a WAV path."
        )

    samples = [float(sample) for sample in audio]
    if any(not math.isfinite(sample) for sample in samples):
        raise ValueError("audio samples must be finite numbers.")
    return samples


def _load_wav_audio(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()

        if channels != 1:
            raise ValueError("Only mono WAV files are supported.")
        if sample_width != 2:
            raise ValueError("Only 16-bit PCM WAV files are supported.")

        frames = wav_file.readframes(frame_count)

    samples: list[float] = []
    for index in range(0, len(frames), 2):
        sample = int.from_bytes(frames[index : index + 2], "little", signed=True)
        samples.append(float(sample) / 32768.0)

    return samples, sample_rate


@dataclass
class VadModel:
    model_id: str
    family: str
    _native_vad: object
    sample_rate: int = DEFAULT_VAD_SAMPLE_RATE

    @property
    def window_size(self) -> int:
        return 256 if self.family.lower().replace("_", "-") in {"ten-vad", "tenvad"} else 512

    def detect(
        self,
        *,
        audio: bytes | Sequence[float] | str | Path,
        sample_rate: Optional[int] = None,
    ) -> VadDetectionResult:
        if isinstance(audio, (str, Path)):
            samples, resolved_sample_rate = _load_wav_audio(Path(audio))
        else:
            if sample_rate is None or sample_rate <= 0:
                raise ValueError("sample_rate is required for in-memory audio.")
            samples = _coerce_audio_samples(audio)
            resolved_sample_rate = int(sample_rate)

        if resolved_sample_rate != self.sample_rate:
            raise ValueError(
                f"VAD expects {self.sample_rate} Hz mono audio; got {resolved_sample_rate} Hz."
            )

        if not hasattr(self._native_vad, "accept_waveform"):
            raise RuntimeError("Native VAD backend does not support accept_waveform().")

        self._native_vad.reset()
        window_size = self.window_size
        for offset in range(0, len(samples), window_size):
            self._native_vad.accept_waveform(samples[offset : offset + window_size])
        self._native_vad.flush()

        segments: list[VadSegment] = []
        speech_sample_count = 0
        while not self._native_vad.empty():
            native_segment = self._native_vad.front
            segment_samples = [float(sample) for sample in native_segment.samples]
            start_sample = int(native_segment.start)
            sample_count = len(segment_samples)
            speech_sample_count += sample_count
            duration_sec = sample_count / float(self.sample_rate)
            start_sec = start_sample / float(self.sample_rate)
            segments.append(
                VadSegment(
                    start_sec=start_sec,
                    duration_sec=duration_sec,
                    end_sec=start_sec + duration_sec,
                    start_sample=start_sample,
                    sample_count=sample_count,
                    sample_rate=self.sample_rate,
                    audio=Audio(samples=segment_samples, sample_rate=self.sample_rate),
                )
            )
            self._native_vad.pop()

        speech_ratio = (
            min(max(speech_sample_count / float(len(samples)), 0.0), 1.0)
            if samples
            else 0.0
        )
        return VadDetectionResult(
            model_id=self.model_id,
            segments=segments,
            speech_ratio=speech_ratio,
        )

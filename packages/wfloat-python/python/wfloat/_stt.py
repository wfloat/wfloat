from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

from ._results import StreamingTranscriptionResult, TranscriptionResult


def _coerce_audio_samples(audio: bytes | Sequence[float]) -> list[float]:
    if isinstance(audio, (bytes, bytearray, memoryview)):
        raise TypeError(
            "Raw PCM bytes are not supported yet. Pass a float sequence or a WAV path."
        )

    return [float(sample) for sample in audio]


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
class SttSession:
    model_id: str
    _native_session: object

    def push(
        self,
        audio: Sequence[float],
        *,
        sample_rate: Optional[int] = None,
    ) -> None:
        if not hasattr(self._native_session, "push"):
            raise RuntimeError("Native STT backend does not support push().")

        self._native_session.push(audio, sample_rate=sample_rate)

    def get_result(self) -> StreamingTranscriptionResult:
        if not hasattr(self._native_session, "get_result"):
            raise RuntimeError("Native STT backend does not support get_result().")

        return self._native_session.get_result()

    def finish(self) -> StreamingTranscriptionResult:
        if not hasattr(self._native_session, "finish"):
            raise RuntimeError("Native STT backend does not support finish().")

        return self._native_session.finish()

    def reset(self) -> None:
        if not hasattr(self._native_session, "reset"):
            raise RuntimeError("Native STT backend does not support reset().")

        self._native_session.reset()

    def close(self) -> None:
        if hasattr(self._native_session, "close"):
            self._native_session.close()


@dataclass
class SttModel:
    model_id: str
    _native_stt: object

    def transcribe(
        self,
        *,
        audio: bytes | Sequence[float] | str | Path,
        sample_rate: Optional[int] = None,
        language: Optional[str] = None,
        task: Optional[str] = None,
        hotwords: Optional[str] = None,
    ) -> TranscriptionResult:
        if isinstance(audio, (str, Path)):
            samples, resolved_sample_rate = _load_wav_audio(Path(audio))
        else:
            if sample_rate is None or sample_rate <= 0:
                raise ValueError("sample_rate is required for in-memory audio.")
            samples = _coerce_audio_samples(audio)
            resolved_sample_rate = int(sample_rate)

        if not hasattr(self._native_stt, "transcribe_result"):
            raise RuntimeError("Native STT backend does not support transcribe_result().")

        return self._native_stt.transcribe_result(
            model_id=self.model_id,
            samples=samples,
            sample_rate=resolved_sample_rate,
            language=language,
            task=task,
            hotwords=hotwords,
        )

    def create_session(self) -> SttSession:
        if not hasattr(self._native_stt, "create_session"):
            raise RuntimeError("Native STT backend does not support create_session().")

        return SttSession(
            model_id=self.model_id,
            _native_session=self._native_stt.create_session(),
        )

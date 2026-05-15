import io
import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional


def _coerce_samples(samples: Iterable[float]) -> List[float]:
    return [float(sample) for sample in samples]


def _sample_to_pcm16(sample: float) -> int:
    clipped = max(-1.0, min(1.0, float(sample)))
    if clipped <= -1.0:
        return -32768
    return int(round(clipped * 32767.0))


def _write_wave_bytes(samples: List[float], sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        frame_bytes = bytearray()
        for sample in samples:
            frame_bytes.extend(struct.pack("<h", _sample_to_pcm16(sample)))
        wav_file.writeframes(bytes(frame_bytes))
    return buffer.getvalue()


@dataclass
class Audio:
    samples: List[float]
    sample_rate: int

    def __post_init__(self) -> None:
        self.samples = _coerce_samples(self.samples)
        self.sample_rate = int(self.sample_rate)

    @property
    def duration_sec(self) -> float:
        if self.sample_rate <= 0:
            return 0.0
        return len(self.samples) / float(self.sample_rate)

    def save(self, path) -> None:
        output_path = Path(path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(self.wav_bytes())

    def wav_bytes(self) -> bytes:
        return _write_wave_bytes(self.samples, self.sample_rate)


AudioResult = Audio


@dataclass
class TimelineChunk:
    index: int
    text: str
    highlight_start: int
    highlight_end: int
    start_sec: float
    end_sec: float
    duration_sec: float
    progress: float
    voice_id: Optional[object]
    sid: int
    emotion: str
    intensity: float
    speed: float
    segment_index: Optional[int] = None


@dataclass
class Timeline:
    chunks: List[TimelineChunk]
    duration_sec: float


@dataclass
class GenerationResult:
    audio: Audio
    timeline: Timeline
    text: str
    model_name: str

    @property
    def model_id(self) -> str:
        return self.model_name

    def __iter__(self):
        yield self.audio
        yield self.timeline


TtsSynthesisResult = GenerationResult


@dataclass
class TranscriptionToken:
    text: str
    start_sec: float
    duration_sec: float
    confidence: float = 0.0


@dataclass
class TranscriptionSegment:
    text: str
    start_sec: float
    duration_sec: float


@dataclass
class TranscriptionResult:
    text: str
    model_id: str
    language: str = ""
    emotion: str = ""
    event: str = ""
    json: str = ""
    tokens: Optional[List[TranscriptionToken]] = None
    segments: Optional[List[TranscriptionSegment]] = None

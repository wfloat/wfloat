from typing import Optional, Union

VoiceId = Union[str, int]

VALID_EMOTIONS = [
    "neutral",
    "joy",
    "sadness",
    "anger",
    "fear",
    "surprise",
    "dismissive",
    "confusion",
]

SPEAKER_IDS = {
    "skilled_hero_man": 0,
    "skilled_hero_woman": 1,
    "fun_hero_man": 2,
    "fun_hero_woman": 3,
    "strong_hero_man": 4,
    "strong_hero_woman": 5,
    "mad_scientist_man": 6,
    "mad_scientist_woman": 7,
    "clever_villain_man": 8,
    "clever_villain_woman": 9,
    "narrator_man": 10,
    "narrator_woman": 11,
    "wise_elder_man": 12,
    "wise_elder_woman": 13,
    "outgoing_anime_man": 14,
    "outgoing_anime_woman": 15,
    "scary_villain_man": 16,
    "scary_villain_woman": 17,
    "news_reporter_man": 18,
    "news_reporter_woman": 19,
}

VALID_SIDS = tuple(SPEAKER_IDS.values())

DEFAULT_VOICE_ID = 0
DEFAULT_EMOTION = "neutral"
DEFAULT_INTENSITY = 0.5
DEFAULT_SPEED = 1.0
DEFAULT_SILENCE_PADDING_SEC = 0.1
DEFAULT_SILENCE_BETWEEN_SEGMENTS_SEC = 0.2
DEFAULT_NUM_THREADS = 1
DEFAULT_PROVIDER = "cpu"
DEFAULT_MODEL_NAME = "wfloat/wfloat-tts"


def normalize_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string.")

    if not text.strip():
        raise ValueError("text is required.")

    return text


def normalize_voice_id(voice_id: Optional[VoiceId]) -> int:
    if voice_id is None:
        return DEFAULT_VOICE_ID

    if isinstance(voice_id, int):
        if voice_id not in VALID_SIDS:
            raise ValueError("Invalid numeric voice_id: %s" % voice_id)
        return voice_id

    if isinstance(voice_id, str):
        trimmed = voice_id.strip()
        if not trimmed:
            return DEFAULT_VOICE_ID

        mapped_sid = SPEAKER_IDS.get(trimmed)
        if mapped_sid is None:
            raise ValueError("Invalid string voice_id: %s" % trimmed)

        return mapped_sid

    raise TypeError("voice_id must be a string, integer, or None.")


def normalize_emotion(emotion: Optional[str]) -> str:
    if emotion is None:
        return DEFAULT_EMOTION

    if not isinstance(emotion, str):
        raise TypeError("emotion must be a string or None.")

    trimmed = emotion.strip()
    if not trimmed:
        return DEFAULT_EMOTION

    if trimmed not in VALID_EMOTIONS:
        raise ValueError("Invalid emotion: %s" % trimmed)

    return trimmed


def normalize_intensity(intensity: Optional[float]) -> float:
    if intensity is None:
        return DEFAULT_INTENSITY

    try:
        value = float(intensity)
    except (TypeError, ValueError):
        raise TypeError("intensity must be a finite number between 0 and 1.")

    if value < 0 or value > 1:
        raise ValueError("intensity must be between 0 and 1.")

    return value


def normalize_speed(speed: Optional[float], default: float = DEFAULT_SPEED) -> float:
    if speed is None:
        return default

    try:
        value = float(speed)
    except (TypeError, ValueError):
        raise TypeError("speed must be a finite number greater than 0.")

    if value <= 0:
        raise ValueError("speed must be greater than 0.")

    return value


def normalize_silence_padding_sec(
    silence_padding_sec: Optional[float],
    default: float = DEFAULT_SILENCE_PADDING_SEC,
) -> float:
    if silence_padding_sec is None:
        return default

    try:
        value = float(silence_padding_sec)
    except (TypeError, ValueError):
        raise TypeError("silence_padding_sec must be a finite number >= 0.")

    if value < 0:
        raise ValueError("silence_padding_sec must be >= 0.")

    return value

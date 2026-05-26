from pathlib import Path

from ._core import create_core_tts


def create_native_tts(
    model_name: str,
    model_path: Path,
    tokens_path: Path,
    espeak_data_dir: Path,
):
    return create_core_tts(
        model_name=model_name,
        model_path=model_path,
        tokens_path=tokens_path,
        espeak_data_dir=espeak_data_dir,
    )

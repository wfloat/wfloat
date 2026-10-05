import platform
import re
import subprocess
from pathlib import Path

import wfloat
from wfloat import _core


PUBLIC_LOADERS = (
    "load_language_model",
    "load_text_to_speech",
    "load_speech_to_text",
    "load_streaming_speech_to_text",
    "load_voice_activity_detection",
    "download_model",
    "delete_model_assets",
    "load",
    "load_stt_model",
    "load_vad_model",
    "load_llm_model",
)


def main() -> None:
    for name in PUBLIC_LOADERS:
        if not callable(getattr(wfloat, name, None)):
            raise AssertionError(f"wfloat.{name} is not callable")

    library = _core._load_core_library()
    from wfloat._llm_bridge import _load_library
    bridge = _load_library()
    if bridge.wfloat_python_llm_abi_version() != 1:
        raise AssertionError("Unexpected Python LLM bridge ABI")

    if platform.system() == "Linux":
        # A repaired wheel must not load both its bundled engine and an
        # auditwheel-grafted copy. Duplicate C++ globals can crash at exit.
        paths = {line.split()[-1] for line in Path("/proc/self/maps").read_text().splitlines()
                 if "/" in line}
        for name in ("libllama", "libggml", "libggml-base", "libggml-cpu"):
            copies = {path for path in paths
                      if re.fullmatch(re.escape(name) + r"(?:-[0-9a-f]+)?\.so(?:\.[0-9.]+)?",
                                      Path(path).name)}
            if len(copies) > 1:
                raise AssertionError(f"Multiple copies of {name} loaded: {sorted(copies)}")

    if platform.system() == "Darwin":
        undefined_symbols = subprocess.check_output(
            ["nm", "-u", library._name],
            text=True,
        )
        if "$NEWLAPACK" in undefined_symbols:
            raise AssertionError(
                "The wheel requires the macOS 13.3 Accelerate LAPACK ABI"
            )

    print(f"Loaded {library._name}")


if __name__ == "__main__":
    main()

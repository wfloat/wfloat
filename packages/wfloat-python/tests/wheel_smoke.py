import platform
import subprocess

import wfloat
from wfloat import _core


PUBLIC_LOADERS = (
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

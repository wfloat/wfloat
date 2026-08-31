from __future__ import annotations

from ..core import Recipe
from .android import RECIPE as ANDROID
from .apple_xcframework import RECIPE as APPLE_XCFRAMEWORK
from .cuda import RECIPE as CUDA
from .directml import RECIPE as DIRECTML
from .linux_cross import RECIPE as LINUX_CROSS
from .linux_native import RECIPE as LINUX_NATIVE
from .macos_shared import RECIPE as MACOS_SHARED
from .macos_static import RECIPE as MACOS_STATIC
from .wasm import RECIPE as WASM
from .windows_arm64x import RECIPE as WINDOWS_ARM64X
from .windows_cpu import RECIPE as WINDOWS_CPU


RECIPES: tuple[Recipe, ...] = (
    ANDROID,
    APPLE_XCFRAMEWORK,
    MACOS_SHARED,
    MACOS_STATIC,
    LINUX_NATIVE,
    LINUX_CROSS,
    CUDA,
    WINDOWS_CPU,
    WINDOWS_ARM64X,
    DIRECTML,
    WASM,
)


def all_recipes() -> tuple[Recipe, ...]:
    return RECIPES

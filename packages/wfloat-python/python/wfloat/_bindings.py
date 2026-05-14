try:
    import sherpa_onnx
except ImportError as exc:
    raise ImportError(
        "Failed to import sherpa_onnx. "
        "Reinstall wfloat so pip can install the matching wfloat-sherpa-onnx dependency."
    ) from exc


_REQUIRED_EXPORTS = (
    "GenerationConfig",
    "OfflineTts",
    "OfflineTtsConfig",
    "OfflineTtsModelConfig",
    "OfflineTtsWfloatModelConfig",
    "WfloatPreparedText",
    "git_date",
    "git_sha1",
    "prepare_wfloat_text",
    "version",
    "write_wave",
)

missing_exports = [name for name in _REQUIRED_EXPORTS if not hasattr(sherpa_onnx, name)]
if missing_exports:
    raise ImportError(
        "Installed sherpa_onnx is missing required exports: "
        f"{', '.join(missing_exports)}. "
        "Reinstall wfloat so pip can install a compatible wfloat-sherpa-onnx build."
    )


GenerationConfig = sherpa_onnx.GenerationConfig
OfflineTts = sherpa_onnx.OfflineTts
OfflineTtsConfig = sherpa_onnx.OfflineTtsConfig
OfflineTtsModelConfig = sherpa_onnx.OfflineTtsModelConfig
OfflineTtsWfloatModelConfig = sherpa_onnx.OfflineTtsWfloatModelConfig
WfloatPreparedText = sherpa_onnx.WfloatPreparedText
git_date = sherpa_onnx.git_date
git_sha1 = sherpa_onnx.git_sha1
prepare_wfloat_text = sherpa_onnx.prepare_wfloat_text
version = sherpa_onnx.version
write_wave = sherpa_onnx.write_wave


__all__ = [
    "GenerationConfig",
    "OfflineTts",
    "OfflineTtsConfig",
    "OfflineTtsModelConfig",
    "OfflineTtsWfloatModelConfig",
    "WfloatPreparedText",
    "git_date",
    "git_sha1",
    "prepare_wfloat_text",
    "version",
    "write_wave",
]

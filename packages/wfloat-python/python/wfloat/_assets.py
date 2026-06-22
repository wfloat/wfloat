from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping, Optional
from urllib.parse import urlparse

from ._generated_model_urls import MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS

REGISTRY_BASE_URL = REGISTRY_ORIGIN
WFLOAT_TTS_MODEL_ID = "wfloat/wfloat-tts"
SILERO_VAD_MODEL_ID = "snakers4/silero-vad"
SMOLLM2_360M_INSTRUCT_MODEL_ID = "HuggingFaceTB/SmolLM2-360M-Instruct"


@dataclass(frozen=True)
class ModelAssets:
    model_onnx: str
    model_onnx_checksum: str
    model_tokens: str
    model_tokens_checksum: str
    espeak_data: str
    espeak_checksum: str

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "ModelAssets":
        required_fields = (
            "model_onnx",
            "model_onnx_checksum",
            "model_tokens",
            "model_tokens_checksum",
            "espeak_data",
            "espeak_checksum",
        )

        missing = [
            field_name
            for field_name in required_fields
            if not isinstance(data.get(field_name), str) or not str(data.get(field_name)).strip()
        ]
        if missing:
            raise ValueError(
                "Model asset response is missing required fields: %s"
                % ", ".join(missing)
            )

        return cls(
            model_onnx=str(data["model_onnx"]),
            model_onnx_checksum=str(data["model_onnx_checksum"]),
            model_tokens=str(data["model_tokens"]),
            model_tokens_checksum=str(data["model_tokens_checksum"]),
            espeak_data=str(data["espeak_data"]),
            espeak_checksum=str(data["espeak_checksum"]),
        )

    def to_dict(self) -> Dict[str, str]:
        return {
            "model_onnx": self.model_onnx,
            "model_onnx_checksum": self.model_onnx_checksum,
            "model_tokens": self.model_tokens,
            "model_tokens_checksum": self.model_tokens_checksum,
            "espeak_data": self.espeak_data,
            "espeak_checksum": self.espeak_checksum,
        }


@dataclass(frozen=True)
class SttModelAssets:
    family: str
    tokens: str
    tokens_checksum: Optional[str] = None
    model: Optional[str] = None
    model_checksum: Optional[str] = None
    preprocessor: Optional[str] = None
    preprocessor_checksum: Optional[str] = None
    encoder: Optional[str] = None
    encoder_checksum: Optional[str] = None
    decoder: Optional[str] = None
    decoder_checksum: Optional[str] = None
    joiner: Optional[str] = None
    joiner_checksum: Optional[str] = None
    uncached_decoder: Optional[str] = None
    uncached_decoder_checksum: Optional[str] = None
    cached_decoder: Optional[str] = None
    cached_decoder_checksum: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "SttModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("STT asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            normalized: Dict[str, str] = {}
            for key, value in files.items():
                if not isinstance(key, str) or not isinstance(value, Mapping):
                    continue
                url = value.get("url")
                checksum = value.get("checksum")
                if isinstance(url, str) and url.strip():
                    normalized[key] = url
                if isinstance(checksum, str) and checksum.strip():
                    normalized[f"{key}_checksum"] = checksum
            merged = dict(data)
            merged.update(normalized)
            data = merged

        required_fields = ("tokens",)
        missing = [
            field_name
            for field_name in required_fields
            if not isinstance(data.get(field_name), str)
            or not str(data.get(field_name)).strip()
        ]
        if missing:
            raise ValueError(
                "STT asset response is missing required fields: %s"
                % ", ".join(missing)
            )

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        return cls(
            family=family,
            tokens=str(data["tokens"]).strip(),
            tokens_checksum=optional_string("tokens_checksum"),
            model=optional_string("model"),
            model_checksum=optional_string("model_checksum"),
            preprocessor=optional_string("preprocessor"),
            preprocessor_checksum=optional_string("preprocessor_checksum"),
            encoder=optional_string("encoder"),
            encoder_checksum=optional_string("encoder_checksum"),
            decoder=optional_string("decoder"),
            decoder_checksum=optional_string("decoder_checksum"),
            joiner=optional_string("joiner"),
            joiner_checksum=optional_string("joiner_checksum"),
            uncached_decoder=optional_string("uncached_decoder"),
            uncached_decoder_checksum=optional_string("uncached_decoder_checksum"),
            cached_decoder=optional_string("cached_decoder"),
            cached_decoder_checksum=optional_string("cached_decoder_checksum"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "family": self.family,
            "tokens": self.tokens,
        }
        optional_fields = {
            "tokens_checksum": self.tokens_checksum,
            "model": self.model,
            "model_checksum": self.model_checksum,
            "preprocessor": self.preprocessor,
            "preprocessor_checksum": self.preprocessor_checksum,
            "encoder": self.encoder,
            "encoder_checksum": self.encoder_checksum,
            "decoder": self.decoder,
            "decoder_checksum": self.decoder_checksum,
            "joiner": self.joiner,
            "joiner_checksum": self.joiner_checksum,
            "uncached_decoder": self.uncached_decoder,
            "uncached_decoder_checksum": self.uncached_decoder_checksum,
            "cached_decoder": self.cached_decoder,
            "cached_decoder_checksum": self.cached_decoder_checksum,
        }
        for key, value in optional_fields.items():
            if value:
                data[key] = value
        return data


@dataclass(frozen=True)
class VadModelAssets:
    family: str
    model: str
    model_checksum: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "VadModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("VAD asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            model_file = files.get("model")
            if isinstance(model_file, Mapping):
                merged = dict(data)
                url = model_file.get("url")
                checksum = model_file.get("checksum")
                if isinstance(url, str) and url.strip():
                    merged["model"] = url
                if isinstance(checksum, str) and checksum.strip():
                    merged["model_checksum"] = checksum
                data = merged

        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("VAD asset response is missing required field: model")

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        return cls(
            family=family,
            model=model,
            model_checksum=optional_string("model_checksum"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "family": self.family,
            "model": self.model,
        }
        if self.model_checksum:
            data["model_checksum"] = self.model_checksum
        return data


@dataclass(frozen=True)
class LlmModelAssets:
    family: str
    model: str
    model_checksum: Optional[str] = None
    context_size: Optional[int] = None
    chat_template: Optional[str] = None
    chat_template_format: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "LlmModelAssets":
        family = str(data.get("family") or "").strip()
        if not family:
            raise ValueError("LLM asset response is missing required field: family")

        files = data.get("files")
        if isinstance(files, Mapping):
            model_file = files.get("model")
            if isinstance(model_file, Mapping):
                merged = dict(data)
                url = model_file.get("url")
                checksum = model_file.get("checksum")
                if isinstance(url, str) and url.strip():
                    merged["model"] = url
                if isinstance(checksum, str) and checksum.strip():
                    merged["model_checksum"] = checksum
                data = merged

        model = str(data.get("model") or "").strip()
        if not model:
            raise ValueError("LLM asset response is missing required field: model")

        def optional_string(key: str) -> Optional[str]:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            return None

        context_size_value = data.get("context_size")
        context_size = None
        if context_size_value is not None:
            context_size = int(context_size_value)

        return cls(
            family=family,
            model=model,
            model_checksum=optional_string("model_checksum"),
            context_size=context_size,
            chat_template=optional_string("chat_template"),
            chat_template_format=optional_string("chat_template_format"),
        )

    def to_dict(self) -> Dict[str, object]:
        data: Dict[str, object] = {
            "family": self.family,
            "model": self.model,
        }
        if self.model_checksum:
            data["model_checksum"] = self.model_checksum
        if self.context_size is not None:
            data["context_size"] = self.context_size
        if self.chat_template:
            data["chat_template"] = self.chat_template
        if self.chat_template_format:
            data["chat_template_format"] = self.chat_template_format
        return data


def filename_from_url(url: str, fallback: str) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path).name
    return filename or fallback


def _registry_url(asset: Mapping[str, object]) -> str:
    path = asset.get("path")
    if not isinstance(path, str) or not path.startswith("/"):
        raise RuntimeError("Registry asset is missing a valid path.")
    return REGISTRY_ORIGIN + path


def _registry_checksum(asset: Mapping[str, object]) -> Optional[str]:
    checksum = asset.get("sha256")
    if isinstance(checksum, str) and checksum.strip():
        return checksum
    return None


def _required_checksum(asset: Mapping[str, object], name: str) -> str:
    checksum = _registry_checksum(asset)
    if checksum is None:
        raise RuntimeError(f"Registry asset is missing required checksum: {name}")
    return checksum


def _model_assets(model_name: str) -> Mapping[str, object]:
    data = MODEL_ASSETS.get(model_name)
    if not isinstance(data, Mapping):
        raise ValueError("Unsupported model: %s" % model_name)
    return data


def _file_asset(data: Mapping[str, object], name: str) -> Mapping[str, object]:
    asset = data.get(name)
    if not isinstance(asset, Mapping):
        raise RuntimeError(f"Registry model entry is missing asset: {name}")
    return asset


def _optional_file_url(data: Mapping[str, object], name: str) -> Optional[str]:
    asset = data.get(name)
    if not isinstance(asset, Mapping):
        return None
    return _registry_url(asset)


def _optional_file_checksum(data: Mapping[str, object], name: str) -> Optional[str]:
    asset = data.get(name)
    if not isinstance(asset, Mapping):
        return None
    return _registry_checksum(asset)


def fetch_model_assets(model_name: str) -> ModelAssets:
    if model_name != WFLOAT_TTS_MODEL_ID:
        raise ValueError("Unsupported TTS model: %s" % model_name)

    model_assets = _model_assets(model_name)
    model_onnx = _file_asset(model_assets, "model_onnx")
    model_tokens = _file_asset(model_assets, "model_tokens")
    espeak_data = SHARED_ASSETS["espeak_ng_data_zip"]

    return ModelAssets(
        model_onnx=_registry_url(model_onnx),
        model_onnx_checksum=_required_checksum(model_onnx, "model_onnx"),
        model_tokens=_registry_url(model_tokens),
        model_tokens_checksum=_required_checksum(model_tokens, "model_tokens"),
        espeak_data=_registry_url(espeak_data),
        espeak_checksum=_required_checksum(espeak_data, "espeak_ng_data_zip"),
    )


def fetch_stt_assets(model_name: str) -> SttModelAssets:
    model_assets = _model_assets(model_name)
    family = model_assets.get("family")
    if family not in {"whisper", "zipformer-transducer", "moonshine"}:
        raise ValueError("Unsupported STT model: %s" % model_name)

    return SttModelAssets(
        family=str(family),
        model=_optional_file_url(model_assets, "model"),
        model_checksum=_optional_file_checksum(model_assets, "model"),
        preprocessor=_optional_file_url(model_assets, "preprocessor"),
        preprocessor_checksum=_optional_file_checksum(model_assets, "preprocessor"),
        encoder=_optional_file_url(model_assets, "encoder"),
        encoder_checksum=_optional_file_checksum(model_assets, "encoder"),
        decoder=_optional_file_url(model_assets, "decoder"),
        decoder_checksum=_optional_file_checksum(model_assets, "decoder"),
        joiner=_optional_file_url(model_assets, "joiner"),
        joiner_checksum=_optional_file_checksum(model_assets, "joiner"),
        uncached_decoder=_optional_file_url(model_assets, "uncached_decoder"),
        uncached_decoder_checksum=_optional_file_checksum(model_assets, "uncached_decoder"),
        cached_decoder=_optional_file_url(model_assets, "cached_decoder"),
        cached_decoder_checksum=_optional_file_checksum(model_assets, "cached_decoder"),
        tokens=_registry_url(_file_asset(model_assets, "tokens")),
        tokens_checksum=_optional_file_checksum(model_assets, "tokens"),
    )


def fetch_vad_assets(model_name: str) -> VadModelAssets:
    if model_name != SILERO_VAD_MODEL_ID:
        raise ValueError("Unsupported VAD model: %s" % model_name)

    model_assets = _model_assets(model_name)
    model = _file_asset(model_assets, "model")

    return VadModelAssets(
        family=str(model_assets.get("family") or "silero-vad"),
        model=_registry_url(model),
        model_checksum=_registry_checksum(model),
    )


def fetch_llm_assets(model_name: str) -> LlmModelAssets:
    if model_name != SMOLLM2_360M_INSTRUCT_MODEL_ID:
        raise ValueError("Unsupported LLM model: %s" % model_name)

    model_assets = _model_assets(model_name)
    model = _file_asset(model_assets, "model")

    return LlmModelAssets(
        family=str(model_assets.get("family") or "smollm"),
        model=_registry_url(model),
        model_checksum=_registry_checksum(model),
        context_size=8192,
        chat_template_format="chatml",
    )

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping, Optional
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from ._version import __version__ as PACKAGE_VERSION


DEFAULT_MODEL_ASSET_HOST = "https://wfloat.com"
DEFAULT_MODEL_ASSET_PATH = "/api/model-assets"


@dataclass(frozen=True)
class ModelAssets:
    model_onnx: str
    model_onnx_checksum: str
    model_tokens: str
    model_tokens_checksum: str
    espeak_data: str
    espeak_checksum: str
    persistent_id: Optional[str] = None

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
            persistent_id=str(data["persistent_id"]).strip()
            if isinstance(data.get("persistent_id"), str) and str(data.get("persistent_id")).strip()
            else None,
        )

    def to_dict(self) -> Dict[str, str]:
        return {
            "model_onnx": self.model_onnx,
            "model_onnx_checksum": self.model_onnx_checksum,
            "model_tokens": self.model_tokens,
            "model_tokens_checksum": self.model_tokens_checksum,
            "espeak_data": self.espeak_data,
            "espeak_checksum": self.espeak_checksum,
            **({"persistent_id": self.persistent_id} if self.persistent_id else {}),
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
    persistent_id: Optional[str] = None

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
            persistent_id=optional_string("persistent_id"),
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
            "persistent_id": self.persistent_id,
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
    persistent_id: Optional[str] = None

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
            persistent_id=optional_string("persistent_id"),
        )

    def to_dict(self) -> Dict[str, str]:
        data = {
            "family": self.family,
            "model": self.model,
        }
        if self.model_checksum:
            data["model_checksum"] = self.model_checksum
        if self.persistent_id:
            data["persistent_id"] = self.persistent_id
        return data


def get_package_version(default: str = "0.0.0") -> str:
    return PACKAGE_VERSION or default


def get_model_asset_host() -> str:
    return os.environ.get("WFLOAT_MODEL_ASSET_HOST", DEFAULT_MODEL_ASSET_HOST).rstrip("/")


def filename_from_url(url: str, fallback: str) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path).name
    return filename or fallback


def _fetch_asset_payload(
    model_name: str,
    *,
    persistent_id: Optional[str] = None,
    package_version_override: Optional[str] = None,
    timeout: float = 60.0,
    extra_query: Optional[Mapping[str, str]] = None,
) -> Dict[str, object]:
    version = package_version_override or get_package_version()
    query = {
        "platform": "python",
        "version": version,
        "model_name": model_name,
    }
    if extra_query:
        query.update(extra_query)
    if persistent_id:
        query["persistent_id"] = persistent_id

    params = urlencode(query)
    url = "%s%s?%s" % (get_model_asset_host(), DEFAULT_MODEL_ASSET_PATH, params)
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "wfloat-python/%s" % version,
        },
        method="GET",
    )

    with urlopen(request, timeout=timeout) as response:
        payload = response.read().decode("utf-8")

    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Failed to decode model asset response JSON.") from exc

    if not isinstance(data, dict):
        raise RuntimeError("Model asset response must be a JSON object.")

    return data


def fetch_model_assets(
    model_name: str,
    *,
    persistent_id: Optional[str] = None,
    package_version_override: Optional[str] = None,
    timeout: float = 60.0,
) -> ModelAssets:
    data = _fetch_asset_payload(
        model_name,
        persistent_id=persistent_id,
        package_version_override=package_version_override,
        timeout=timeout,
    )
    return ModelAssets.from_dict(data)


def fetch_stt_assets(
    model_name: str,
    *,
    family: Optional[str] = None,
    persistent_id: Optional[str] = None,
    package_version_override: Optional[str] = None,
    timeout: float = 60.0,
) -> SttModelAssets:
    extra_query = {}
    if family:
        extra_query["family"] = family

    data = _fetch_asset_payload(
        model_name,
        persistent_id=persistent_id,
        package_version_override=package_version_override,
        timeout=timeout,
        extra_query=extra_query,
    )
    return SttModelAssets.from_dict(data)


def fetch_vad_assets(
    model_name: str,
    *,
    family: Optional[str] = None,
    persistent_id: Optional[str] = None,
    package_version_override: Optional[str] = None,
    timeout: float = 60.0,
) -> VadModelAssets:
    extra_query = {}
    if family:
        extra_query["family"] = family

    data = _fetch_asset_payload(
        model_name,
        persistent_id=persistent_id,
        package_version_override=package_version_override,
        timeout=timeout,
        extra_query=extra_query,
    )
    return VadModelAssets.from_dict(data)

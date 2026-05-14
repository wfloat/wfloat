import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
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


def get_package_version(default: str = "0.0.0") -> str:
    return PACKAGE_VERSION or default


def get_model_asset_host() -> str:
    return os.environ.get("WFLOAT_MODEL_ASSET_HOST", DEFAULT_MODEL_ASSET_HOST).rstrip("/")


def filename_from_url(url: str, fallback: str) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path).name
    return filename or fallback


def fetch_model_assets(
    model_name: str,
    *,
    persistent_id: Optional[str] = None,
    package_version_override: Optional[str] = None,
    timeout: float = 60.0,
) -> ModelAssets:
    version = package_version_override or get_package_version()
    query = {
        "platform": "python",
        "version": version,
        "model_name": model_name,
    }
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

    return ModelAssets.from_dict(data)

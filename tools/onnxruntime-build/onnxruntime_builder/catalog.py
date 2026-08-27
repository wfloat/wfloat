from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any


BUILDER_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG_PATH = BUILDER_ROOT / "targets.json"
TARGET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class CatalogError(ValueError):
    pass


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key == "profile":
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class Catalog:
    def __init__(self, data: dict[str, Any], path: Path = DEFAULT_CATALOG_PATH):
        self.data = data
        self.path = path
        self._validate()

    @classmethod
    def load(cls, path: Path | None = None) -> "Catalog":
        catalog_path = (path or DEFAULT_CATALOG_PATH).resolve()
        try:
            with catalog_path.open(encoding="utf-8") as stream:
                data = json.load(stream)
        except (OSError, json.JSONDecodeError) as error:
            raise CatalogError(f"unable to load target catalog {catalog_path}: {error}") from error
        return cls(data, catalog_path)

    @property
    def default_version(self) -> str:
        return self.data["default_onnxruntime_version"]

    @property
    def source_repository(self) -> str:
        return self.data["source_repository"]

    @property
    def target_ids(self) -> list[str]:
        return list(self.data["targets"])

    def target(self, target_id: str) -> dict[str, Any]:
        try:
            raw = self.data["targets"][target_id]
        except KeyError as error:
            choices = ", ".join(self.target_ids)
            raise CatalogError(f"unknown target {target_id!r}; choose one of: {choices}") from error
        profile_name = raw["profile"]
        resolved = _deep_merge(self.data["profiles"][profile_name], raw)
        resolved["id"] = target_id
        resolved["family"] = raw.get("family", target_id)
        resolved["profile"] = profile_name
        return resolved

    def targets(self, platform: str | None = None) -> list[dict[str, Any]]:
        targets = [self.target(target_id) for target_id in self.target_ids]
        if platform:
            targets = [target for target in targets if target["platform"] == platform]
        return targets

    def _validate(self) -> None:
        required_root = {
            "schema_version",
            "default_onnxruntime_version",
            "source_repository",
            "profiles",
            "targets",
        }
        missing = required_root - self.data.keys()
        if missing:
            raise CatalogError(f"catalog is missing keys: {', '.join(sorted(missing))}")
        if self.data["schema_version"] != 1:
            raise CatalogError(f"unsupported target catalog schema {self.data['schema_version']!r}")
        if self.data["source_repository"] != "https://github.com/microsoft/onnxruntime.git":
            raise CatalogError("source_repository must be Microsoft's ONNX Runtime repository")
        if not isinstance(self.data["profiles"], dict) or not isinstance(self.data["targets"], dict):
            raise CatalogError("profiles and targets must be objects")
        if not self.data["targets"]:
            raise CatalogError("target catalog is empty")

        for target_id, raw in self.data["targets"].items():
            if not TARGET_ID_RE.fullmatch(target_id) or target_id != target_id.lower():
                raise CatalogError(f"invalid target identifier: {target_id!r}")
            if not isinstance(raw, dict):
                raise CatalogError(f"target {target_id} must be an object")
            profile_name = raw.get("profile")
            if profile_name not in self.data["profiles"]:
                raise CatalogError(f"target {target_id} references unknown profile {profile_name!r}")
            target = _deep_merge(self.data["profiles"][profile_name], raw)
            required = {"platform", "host", "driver", "linkage", "providers", "package", "validation"}
            target_missing = required - target.keys()
            if target_missing:
                raise CatalogError(
                    f"target {target_id} is missing resolved keys: {', '.join(sorted(target_missing))}"
                )
            if target.get("family", target_id) != target.get("family", target_id).lower():
                raise CatalogError(f"target {target_id} has a non-lowercase family")
            package = target["package"]
            if package.get("kind") != "xcframework" and not package.get("headers_dir"):
                raise CatalogError(f"target {target_id} has no package headers_dir")
            if (
                package.get("kind") not in {"android", "xcframework"}
                and not package.get("required_libraries")
            ):
                raise CatalogError(f"target {target_id} has no required package libraries")

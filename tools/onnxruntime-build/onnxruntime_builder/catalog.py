from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

from .core import Recipe


BUILDER_ROOT = Path(__file__).resolve().parent.parent
SOURCE_LOCK_PATH = BUILDER_ROOT / "source-lock.json"
TARGET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$")
FULL_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
MICROSOFT_REPOSITORY = "https://github.com/microsoft/onnxruntime.git"


class CatalogError(ValueError):
    pass


class Catalog:
    def __init__(
        self,
        source_lock: dict[str, Any],
        recipes: tuple[Recipe, ...],
        path: Path = SOURCE_LOCK_PATH,
    ):
        self.source_lock = source_lock
        self.path = path
        self._recipes = {recipe.name: recipe for recipe in recipes}
        self._targets: dict[str, dict] = {}
        self._target_recipes: dict[str, Recipe] = {}
        for recipe in recipes:
            if not recipe.name or recipe.name != recipe.name.lower():
                raise CatalogError(f"invalid recipe name {recipe.name!r}")
            for target_id, definition in recipe.targets.items():
                if target_id in self._targets:
                    raise CatalogError(f"duplicate target identifier {target_id!r}")
                target = copy.deepcopy(definition)
                target["id"] = target_id
                target["family"] = target.get("family", target_id)
                target["recipe"] = recipe.name
                self._targets[target_id] = target
                self._target_recipes[target_id] = recipe
        self._validate()

    @classmethod
    def load(cls, path: Path | None = None) -> "Catalog":
        lock_path = (path or SOURCE_LOCK_PATH).resolve()
        try:
            with lock_path.open(encoding="utf-8") as stream:
                source_lock = json.load(stream)
        except (OSError, json.JSONDecodeError) as error:
            raise CatalogError(f"unable to load Microsoft source lock {lock_path}: {error}") from error
        from .recipes import all_recipes

        return cls(source_lock, all_recipes(), lock_path)

    @property
    def default_version(self) -> str:
        return self.source_lock["default_version"]

    @property
    def source_repository(self) -> str:
        return self.source_lock["repository"]

    def source_revision(self, version: str) -> str:
        if not VERSION_RE.fullmatch(version) or version != version.lower():
            raise CatalogError(
                f"ONNX Runtime version must be an exact version such as 1.29.0; got {version!r}"
            )
        try:
            return self.source_lock["revisions"][version]
        except KeyError as error:
            raise CatalogError(
                f"ONNX Runtime version {version!r} has no committed source revision in {self.path}"
            ) from error

    @property
    def target_ids(self) -> list[str]:
        return list(self._targets)

    def target(self, target_id: str) -> dict[str, Any]:
        try:
            return copy.deepcopy(self._targets[target_id])
        except KeyError as error:
            choices = ", ".join(self.target_ids)
            raise CatalogError(f"unknown target {target_id!r}; choose one of: {choices}") from error

    def recipe(self, target_id: str) -> Recipe:
        try:
            return self._target_recipes[target_id]
        except KeyError as error:
            raise CatalogError(f"unknown target {target_id!r}") from error

    def targets(self, platform: str | None = None) -> list[dict[str, Any]]:
        targets = [self.target(target_id) for target_id in self.target_ids]
        if platform:
            targets = [target for target in targets if target["platform"] == platform]
        return targets

    def _validate(self) -> None:
        required_lock = {"repository", "default_version", "revisions"}
        missing_lock = required_lock - self.source_lock.keys()
        if missing_lock:
            raise CatalogError(f"source lock is missing keys: {', '.join(sorted(missing_lock))}")
        if self.source_repository != MICROSOFT_REPOSITORY:
            raise CatalogError("source lock repository must be Microsoft's ONNX Runtime repository")
        revisions = self.source_lock["revisions"]
        if not isinstance(revisions, dict) or not revisions:
            raise CatalogError("source lock revisions must be a non-empty version-to-commit map")
        for version, commit in revisions.items():
            if not VERSION_RE.fullmatch(version) or version != version.lower():
                raise CatalogError(f"invalid source revision version: {version!r}")
            if not isinstance(commit, str) or not FULL_COMMIT_RE.fullmatch(commit):
                raise CatalogError(
                    f"source revision for {version} must be a lowercase 40-character commit"
                )
        if self.default_version not in revisions:
            raise CatalogError("default_version must have a committed source revision")
        if not self._targets:
            raise CatalogError("target catalog is empty")

        for target_id, target in self._targets.items():
            if not TARGET_ID_RE.fullmatch(target_id) or target_id != target_id.lower():
                raise CatalogError(f"invalid target identifier: {target_id!r}")
            required = {
                "id",
                "family",
                "recipe",
                "platform",
                "host",
                "linkage",
                "providers",
                "package",
                "validation",
                "verification",
            }
            missing = required - target.keys()
            if missing:
                raise CatalogError(
                    f"target {target_id} is missing keys: {', '.join(sorted(missing))}"
                )
            if target["recipe"] not in self._recipes:
                raise CatalogError(f"target {target_id} references unknown recipe {target['recipe']!r}")
            if target["family"] != target["family"].lower():
                raise CatalogError(f"target {target_id} has a non-lowercase family")
            if target["verification"] not in {"verified", "unverified"}:
                raise CatalogError(
                    f"target {target_id} verification must be 'verified' or 'unverified'"
                )
            validation = target["validation"]
            if set(validation) != {"test_policy"}:
                raise CatalogError(
                    f"target {target_id} validation may contain only the enforced test_policy"
                )
            if validation["test_policy"] not in {"native", "cross", "gpu-compile"}:
                raise CatalogError(f"target {target_id} has an unknown Microsoft test policy")
            package = target["package"]
            if package.get("kind") != "xcframework" and not package.get("headers_dir"):
                raise CatalogError(f"target {target_id} has no package headers_dir")
            if package.get("kind") not in {"android", "xcframework"} and not package.get(
                "required_libraries"
            ):
                raise CatalogError(f"target {target_id} has no required package libraries")

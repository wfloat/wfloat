from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import urlparse

from ._assets import VadModelAssets
from ._download import download_file, verify_checksum


@dataclass(frozen=True)
class CachedVadAssets:
    model_name: str
    family: str
    cache_dir: Path
    files: Mapping[str, Path]

    def require(self, key: str) -> Path:
        path = self.files.get(key)
        if path is None:
            raise ValueError(f"Missing required VAD asset: {key}")
        return path


def _normalize_model_dir_name(model_name: str) -> str:
    return model_name.replace("/", "--").replace(" ", "-")


def _is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https", "file"}


def _copy_local_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(str(source), str(destination))


def _materialize_asset(
    source: str | Path,
    destination: Path,
    *,
    expected_checksum: Optional[str],
    force_download: bool,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)

    if not force_download and destination.is_file():
        if expected_checksum is None or verify_checksum(destination, expected_checksum):
            return destination

    if isinstance(source, Path):
        _copy_local_file(source, destination)
    else:
        source_str = str(source)
        if _is_url(source_str):
            download_file(source_str, destination, expected_checksum=expected_checksum)
        else:
            _copy_local_file(Path(source_str), destination)

    if expected_checksum is not None and not verify_checksum(destination, expected_checksum):
        raise RuntimeError(f"Cached VAD asset checksum mismatch for {destination}.")

    return destination


def cache_vad_assets(
    model_name: str,
    *,
    family: str,
    sources: Mapping[str, str | Path | None],
    checksums: Optional[Mapping[str, str]] = None,
    cache_dir: Path,
    force_download: bool = False,
) -> CachedVadAssets:
    model_dir = cache_dir / "models" / _normalize_model_dir_name(model_name)
    model_dir.mkdir(parents=True, exist_ok=True)
    checksums = checksums or {}

    files: dict[str, Path] = {}
    for key, source in sources.items():
        if source is None:
            continue

        source_value = Path(source) if isinstance(source, Path) else str(source)
        filename = Path(urlparse(str(source_value)).path).name or Path(str(source_value)).name
        if not filename:
            raise ValueError(f"Could not derive filename for VAD asset {key}.")

        destination = model_dir / filename
        files[key] = _materialize_asset(
            source_value,
            destination,
            expected_checksum=checksums.get(key),
            force_download=force_download,
        )

    return CachedVadAssets(
        model_name=model_name,
        family=family,
        cache_dir=cache_dir,
        files=files,
    )


def cache_vad_model_assets(
    model_name: str,
    assets: VadModelAssets,
    *,
    cache_dir: Path,
    force_download: bool = False,
) -> CachedVadAssets:
    return cache_vad_assets(
        model_name,
        family=assets.family,
        sources={
            "model": assets.model,
        },
        checksums={
            key: value
            for key, value in {
                "model": assets.model_checksum,
            }.items()
            if value is not None
        },
        cache_dir=cache_dir,
        force_download=force_download,
    )

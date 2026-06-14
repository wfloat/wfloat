import json
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ._assets import ModelAssets, filename_from_url
from ._download import (
    download_file,
    extract_archive,
    normalize_checksum,
    resolve_extracted_data_directory,
    verify_checksum,
)


@dataclass(frozen=True)
class CachedModelAssets:
    model_name: str
    cache_dir: Path
    model_path: Path
    tokens_path: Path
    espeak_data_dir: Path
    manifest_path: Path


def get_default_cache_dir() -> Path:
    if os.name == "nt":
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / "wfloat" / "Cache"
        return Path.home() / "AppData" / "Local" / "wfloat" / "Cache"

    if sys_platform_startswith("darwin"):
        return Path.home() / "Library" / "Caches" / "wfloat"

    xdg_cache_home = os.environ.get("XDG_CACHE_HOME")
    if xdg_cache_home:
        return Path(xdg_cache_home) / "wfloat"

    return Path.home() / ".cache" / "wfloat"


def sys_platform_startswith(prefix: str) -> bool:
    import sys

    return sys.platform.startswith(prefix)


def normalize_model_name(model_name: str) -> str:
    normalized = model_name.strip().replace("\\", "/")
    normalized = normalized.replace("/", "--")
    normalized = normalized.replace(" ", "-")
    return normalized


def _ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _cleanup_stale_model_files(model_dir: Path, active_names) -> None:
    if not model_dir.exists():
        return

    for child in model_dir.iterdir():
        if child.name in active_names:
            continue
        if child.is_file():
            child.unlink()


def _write_manifest(manifest_path: Path, model_name: str, assets: ModelAssets) -> None:
    manifest_payload = {
        "model_name": model_name,
        "assets": assets.to_dict(),
    }
    manifest_path.write_text(json.dumps(manifest_payload, indent=2, sort_keys=True) + "\n")


def _ensure_cached_file(
    source_url: str,
    checksum: str,
    destination: Path,
    downloads_dir: Path,
    *,
    force_download: bool,
) -> Path:
    if not force_download and verify_checksum(destination, checksum):
        return destination

    suffix = destination.suffix or ".bin"
    temp_download = downloads_dir / (uuid.uuid4().hex + suffix)
    download_file(source_url, temp_download, expected_checksum=checksum)
    _ensure_directory(destination.parent)
    os.replace(str(temp_download), str(destination))
    return destination


def _install_espeak_data(
    assets: ModelAssets,
    cache_root: Path,
    downloads_dir: Path,
    *,
    force_download: bool,
) -> Path:
    checksum = normalize_checksum(assets.espeak_checksum)
    espeak_root = cache_root / "espeak" / checksum
    data_dir = espeak_root / "espeak-ng-data"
    ready_marker = espeak_root / ".ready"

    if (
        not force_download
        and ready_marker.is_file()
        and data_dir.is_dir()
    ):
        return data_dir

    if espeak_root.exists():
        shutil.rmtree(espeak_root)

    _ensure_directory(espeak_root)
    archive_name = filename_from_url(assets.espeak_data, checksum + ".zip")
    temp_archive = downloads_dir / (uuid.uuid4().hex + "-" + archive_name)
    download_file(
        assets.espeak_data,
        temp_archive,
        expected_checksum=assets.espeak_checksum,
    )

    extraction_root = Path(
        tempfile.mkdtemp(prefix="wfloat-espeak-", dir=str(downloads_dir))
    )
    try:
        extract_archive(temp_archive, extraction_root)
        resolved_data_dir = resolve_extracted_data_directory(extraction_root)
        if data_dir.exists():
            shutil.rmtree(data_dir)
        shutil.copytree(str(resolved_data_dir), str(data_dir))
        ready_marker.write_text("ready\n")
    finally:
        if temp_archive.exists():
            temp_archive.unlink()
        if extraction_root.exists():
            shutil.rmtree(extraction_root)

    return data_dir


def cache_model_assets(
    model_name: str,
    assets: ModelAssets,
    *,
    cache_dir: Optional[Path] = None,
    force_download: bool = False,
) -> CachedModelAssets:
    cache_root = Path(cache_dir) if cache_dir is not None else get_default_cache_dir()
    models_dir = cache_root / "models"
    downloads_dir = cache_root / "downloads"

    _ensure_directory(models_dir)
    _ensure_directory(downloads_dir)

    model_dir = models_dir / normalize_model_name(model_name)
    _ensure_directory(model_dir)

    model_filename = filename_from_url(assets.model_onnx, "model.onnx")
    tokens_filename = filename_from_url(assets.model_tokens, "tokens.txt")
    manifest_path = model_dir / "manifest.json"

    _cleanup_stale_model_files(
        model_dir,
        active_names={model_filename, tokens_filename, "manifest.json"},
    )

    model_path = _ensure_cached_file(
        assets.model_onnx,
        assets.model_onnx_checksum,
        model_dir / model_filename,
        downloads_dir,
        force_download=force_download,
    )
    tokens_path = _ensure_cached_file(
        assets.model_tokens,
        assets.model_tokens_checksum,
        model_dir / tokens_filename,
        downloads_dir,
        force_download=force_download,
    )
    espeak_data_dir = _install_espeak_data(
        assets,
        cache_root,
        downloads_dir,
        force_download=force_download,
    )

    _write_manifest(manifest_path, model_name, assets)

    return CachedModelAssets(
        model_name=model_name,
        cache_dir=cache_root,
        model_path=model_path,
        tokens_path=tokens_path,
        espeak_data_dir=espeak_data_dir,
        manifest_path=manifest_path,
    )

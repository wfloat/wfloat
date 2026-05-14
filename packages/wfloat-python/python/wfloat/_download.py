import hashlib
import os
import shutil
import tarfile
import uuid
import zipfile
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen


def normalize_checksum(checksum: str) -> str:
    normalized = checksum.strip().lower()
    if normalized.startswith("sha256:"):
        return normalized.split(":", 1)[1]
    if normalized.startswith("sha256-"):
        return normalized.split("-", 1)[1]
    return normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_obj:
        while True:
            chunk = file_obj.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksum(path: Path, checksum: str) -> bool:
    if not path.is_file():
        return False
    return sha256_file(path) == normalize_checksum(checksum)


def download_file(
    url: str,
    destination: Path,
    *,
    expected_checksum: Optional[str] = None,
    timeout: float = 60.0,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_name(destination.name + ".tmp-" + uuid.uuid4().hex)

    request = Request(
        url,
        headers={
            "Accept": "*/*",
            "User-Agent": "wfloat-python/0.0.0",
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            with temp_path.open("wb") as file_obj:
                shutil.copyfileobj(response, file_obj)

        if expected_checksum is not None and not verify_checksum(temp_path, expected_checksum):
            raise RuntimeError(
                "Downloaded file checksum did not match expected value for %s." % url
            )

        os.replace(str(temp_path), str(destination))
        return destination
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _assert_within_destination(path: Path, destination: Path) -> None:
    resolved_destination = destination.resolve()
    resolved_path = path.resolve()
    destination_str = str(resolved_destination)
    path_str = str(resolved_path)
    if path_str != destination_str and not path_str.startswith(destination_str + os.sep):
        raise RuntimeError("Archive member would extract outside destination: %s" % path)


def _extract_zip(archive_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            member_path = destination / member.filename
            _assert_within_destination(member_path, destination)
        archive.extractall(destination)


def _extract_tar(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            member_path = destination / member.name
            _assert_within_destination(member_path, destination)
        archive.extractall(destination)


def extract_archive(archive_path: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if zipfile.is_zipfile(archive_path):
        _extract_zip(archive_path, destination)
        return

    if tarfile.is_tarfile(archive_path):
        _extract_tar(archive_path, destination)
        return

    raise RuntimeError(
        "Unsupported archive format for %s. Python model assets should provide a zip or tar archive."
        % archive_path
    )


def resolve_extracted_data_directory(extraction_root: Path) -> Path:
    visible_contents = [
        path
        for path in extraction_root.iterdir()
        if not path.name.startswith(".") and path.name != "__MACOSX"
    ]

    named_directory = extraction_root / "espeak-ng-data"
    if named_directory.is_dir():
        return named_directory

    child_directories = [path for path in visible_contents if path.is_dir()]
    if len(visible_contents) == 1 and len(child_directories) == 1:
        return child_directories[0]

    return extraction_root

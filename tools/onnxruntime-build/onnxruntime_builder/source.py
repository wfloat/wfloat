from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path


MICROSOFT_REPOSITORY = "https://github.com/microsoft/onnxruntime.git"
FULL_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$")


class SourceError(RuntimeError):
    pass


def _run(command: list[str], *, cwd: Path | None = None, capture: bool = False) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def _normalized_remote(url: str) -> str:
    normalized = url.strip().removesuffix("/").removesuffix(".git")
    if normalized.startswith("git@github.com:"):
        normalized = "https://github.com/" + normalized.removeprefix("git@github.com:")
    if normalized.startswith("ssh://git@github.com/"):
        normalized = "https://github.com/" + normalized.removeprefix("ssh://git@github.com/")
    return normalized.lower()


def verify_microsoft_source(source_dir: Path) -> str:
    try:
        remote = _run(["git", "remote", "get-url", "origin"], cwd=source_dir, capture=True)
        commit = _run(["git", "rev-parse", "HEAD^{commit}"], cwd=source_dir, capture=True).lower()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SourceError(f"{source_dir} is not a usable ONNX Runtime Git checkout") from error
    if _normalized_remote(remote) != _normalized_remote(MICROSOFT_REPOSITORY):
        raise SourceError(
            f"source checkout origin must be {MICROSOFT_REPOSITORY}; found {remote!r}"
        )
    if not FULL_COMMIT_RE.fullmatch(commit):
        raise SourceError(f"unable to resolve an exact Microsoft commit in {source_dir}")
    return commit


def acquire_source(
    cache_dir: Path,
    version: str,
    source_revision: str,
    jobs: int,
    source_dir: Path | None = None,
) -> tuple[Path, str]:
    if not VERSION_RE.fullmatch(version) or version != version.lower():
        raise SourceError(f"ONNX Runtime version must be an exact version such as 1.29.0; got {version!r}")
    if not FULL_COMMIT_RE.fullmatch(source_revision) or source_revision != source_revision.lower():
        raise SourceError("cataloged source revision must be a lowercase 40-character commit")

    desired_ref = source_revision
    if source_dir is not None:
        resolved_dir = source_dir.resolve()
        commit = verify_microsoft_source(resolved_dir)
        if commit != source_revision:
            raise SourceError(
                f"source checkout is {commit}, not cataloged commit {source_revision} for {version}"
            )
        _run(["git", "fetch", "--depth", "1", "origin", desired_ref], cwd=resolved_dir)
        requested_commit = _run(
            ["git", "rev-parse", "FETCH_HEAD^{commit}"], cwd=resolved_dir, capture=True
        ).lower()
        if requested_commit != source_revision:
            raise SourceError(
                f"Microsoft origin resolved cataloged commit {source_revision} as {requested_commit}"
            )
        _run(
            ["git", "submodule", "update", "--init", "--recursive", "--depth", "1", "--jobs", str(jobs)],
            cwd=resolved_dir,
        )
        return resolved_dir, commit

    cache_dir = cache_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / f"onnxruntime-{version}"
    if destination.exists():
        commit = verify_microsoft_source(destination)
        _run(["git", "fetch", "--depth", "1", "origin", desired_ref], cwd=destination)
        requested_commit = _run(
            ["git", "rev-parse", "FETCH_HEAD^{commit}"], cwd=destination, capture=True
        ).lower()
        if requested_commit != source_revision:
            raise SourceError(
                f"Microsoft origin resolved cataloged commit {source_revision} as {requested_commit}"
            )
        if commit != requested_commit:
            raise SourceError(
                f"cached source {destination} is {commit}, expected {requested_commit}; remove that cache directory"
            )
    else:
        temporary = destination.with_name(destination.name + ".partial")
        if temporary.exists():
            shutil.rmtree(temporary)
        _run(["git", "clone", "--filter=blob:none", "--no-checkout", MICROSOFT_REPOSITORY, str(temporary)])
        try:
            _run(["git", "fetch", "--depth", "1", "origin", desired_ref], cwd=temporary)
            commit = _run(["git", "rev-parse", "FETCH_HEAD^{commit}"], cwd=temporary, capture=True).lower()
            if commit != source_revision:
                raise SourceError(
                    f"Microsoft origin resolved cataloged commit {source_revision} as {commit}"
                )
            _run(["git", "checkout", "--detach", commit], cwd=temporary)
            temporary.rename(destination)
        except Exception:
            if temporary.exists():
                shutil.rmtree(temporary)
            raise

    _run(["git", "submodule", "sync", "--recursive"], cwd=destination)
    _run(
        ["git", "submodule", "update", "--init", "--recursive", "--depth", "1", "--jobs", str(jobs)],
        cwd=destination,
    )
    return destination, verify_microsoft_source(destination)

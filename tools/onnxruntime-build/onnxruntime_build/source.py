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


def _run(
    command: list[str],
    *,
    cwd: Path | None = None,
    capture: bool = False,
    strip: bool = True,
) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if not capture:
        return ""
    return result.stdout.strip() if strip else result.stdout.rstrip("\n")


def _normalized_remote(url: str) -> str:
    normalized = url.strip().removesuffix("/").removesuffix(".git")
    if normalized.startswith("git@github.com:"):
        normalized = "https://github.com/" + normalized.removeprefix("git@github.com:")
    if normalized.startswith("ssh://git@github.com/"):
        normalized = "https://github.com/" + normalized.removeprefix("ssh://git@github.com/")
    return normalized.lower()


def _verify_microsoft_identity(source_dir: Path) -> str:
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


def _verify_checkout_integrity(source_dir: Path, *, include_ignored: bool = True) -> None:
    status_command = [
        "git",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ]
    if include_ignored:
        status_command.append("--ignored=matching")
    status = _run(
        status_command,
        cwd=source_dir,
        capture=True,
    )
    if status:
        raise SourceError(
            f"Microsoft source checkout must be clean, including submodules; dirty paths:\n{status}"
        )

    submodule_status = _run(
        ["git", "submodule", "status", "--recursive"],
        cwd=source_dir,
        capture=True,
        strip=False,
    )
    invalid = [line for line in submodule_status.splitlines() if line and line[0] != " "]
    if invalid:
        raise SourceError(
            "Microsoft source submodules must be initialized at the recorded gitlinks:\n"
            + "\n".join(invalid)
        )

    submodule_status_command = (
        "git status --porcelain=v1 --untracked-files=all --ignore-submodules=none"
    )
    if include_ignored:
        submodule_status_command += " --ignored=matching"
    dirty_submodules = _run(
        [
            "git",
            "submodule",
            "foreach",
            "--quiet",
            "--recursive",
            submodule_status_command,
        ],
        cwd=source_dir,
        capture=True,
    )
    if dirty_submodules:
        raise SourceError(
            "Microsoft source contains modified, untracked, or ignored submodule contents:\n"
            + dirty_submodules
        )


def _sanitize_managed_cache(source_dir: Path) -> None:
    """Remove ignored build/tool outputs only from the builder-owned source cache."""
    _verify_microsoft_identity(source_dir)
    _verify_checkout_integrity(source_dir, include_ignored=False)
    _run(
        ["git", "submodule", "foreach", "--quiet", "--recursive", "git clean -ffdX"],
        cwd=source_dir,
    )
    _run(["git", "clean", "-ffdX"], cwd=source_dir)


def verify_microsoft_source(source_dir: Path) -> str:
    commit = _verify_microsoft_identity(source_dir)
    try:
        _verify_checkout_integrity(source_dir)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SourceError(f"unable to verify exact Microsoft source contents in {source_dir}") from error
    return commit


def verify_microsoft_source_after_build(source_dir: Path) -> str:
    """Recheck immutable Git inputs while allowing ignored outputs created by Microsoft tools."""
    commit = _verify_microsoft_identity(source_dir)
    try:
        _verify_checkout_integrity(source_dir, include_ignored=False)
    except (OSError, subprocess.CalledProcessError) as error:
        raise SourceError(f"unable to reverify Microsoft source after building in {source_dir}") from error
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
        verified_commit = verify_microsoft_source(resolved_dir)
        return resolved_dir, verified_commit

    cache_dir = cache_dir.resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / f"onnxruntime-{version}"
    if destination.exists():
        _sanitize_managed_cache(destination)
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

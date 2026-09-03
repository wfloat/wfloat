#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping


BUILDER_ROOT = Path(__file__).resolve().parents[1] / "tools" / "onnxruntime-build"
SOURCE_LOCK = BUILDER_ROOT / "source-lock.json"
BROKER_AUDIENCE = "https://wfloat.com/api/onnxruntime/credentials"
PUBLIC_ORIGIN = "https://registry.wfloat.com"
MAX_SINGLE_PUT_BYTES = 5 * 1024**3
DOWNLOAD_BLOCK_BYTES = 8 * 1024 * 1024
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
BUILDER_PATTERN = re.compile(r"^[0-9a-f]{12}$")
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")

TARGETS_BY_WORKFLOW = {
    "onnxruntime-builder-android.yml": {"android"},
    "onnxruntime-builder-apple.yml": {
        "ios-static-xcframework",
        "osx-arm64-static_lib",
        "osx-x86_64-static_lib",
    },
    "onnxruntime-builder-linux.yml": {
        "linux-x64-glibc2_17",
        "linux-aarch64-glibc2_17",
    },
    "onnxruntime-builder-wasm.yml": {"wasm-static_lib-simd"},
    "onnxruntime-builder-windows.yml": {"win-x64-static_lib-mt"},
}
APPROVED_TARGETS = frozenset().union(*TARGETS_BY_WORKFLOW.values())


class PublicationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Artifact:
    path: Path
    target: str
    version: str
    builder: str
    key: str
    size: int
    sha256: str


@dataclass(frozen=True)
class TemporaryCredential:
    access_key_id: str
    secret_access_key: str
    session_token: str


@dataclass(frozen=True)
class PublicationGrant:
    endpoint: str
    bucket: str
    key: str
    public_url: str
    credential: TemporaryCredential


def _required_environment(name: str, environment: Mapping[str, str]) -> str:
    value = environment.get(name, "")
    if not value:
        raise PublicationError(f"required GitHub Actions environment variable is missing: {name}")
    return value


def _load_default_version() -> str:
    try:
        source_lock = json.loads(SOURCE_LOCK.read_text(encoding="utf-8"))
        version = source_lock["default_version"]
        revision = source_lock["revisions"][version]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise PublicationError(f"unable to read the committed source lock: {error}") from error
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise PublicationError("source-lock.json has an invalid default_version")
    if not isinstance(revision, str) or not SHA_PATTERN.fullmatch(revision):
        raise PublicationError("source-lock.json has an invalid revision for default_version")
    return version


def _workflow_name(workflow_ref: str) -> str:
    match = re.fullmatch(
        r"wfloat/wfloat/\.github/workflows/([^/@]+)@refs/heads/main", workflow_ref
    )
    if not match or match.group(1) not in TARGETS_BY_WORKFLOW:
        raise PublicationError(
            "GITHUB_WORKFLOW_REF is not an approved ONNX Runtime builder workflow on main"
        )
    return match.group(1)


def _parse_archive_name(path: Path) -> tuple[str, str, str]:
    if path.suffix != ".zip":
        raise PublicationError(f"artifact is not a zip archive: {path}")
    for target in sorted(APPROVED_TARGETS, key=len, reverse=True):
        prefix = f"onnxruntime-{target}-"
        if not path.stem.startswith(prefix):
            continue
        identity = path.stem.removeprefix(prefix)
        try:
            version, builder = identity.rsplit("-", 1)
        except ValueError as error:
            raise PublicationError(f"artifact identity is incomplete: {path.name}") from error
        if not VERSION_PATTERN.fullmatch(version):
            raise PublicationError(f"artifact has an invalid ONNX Runtime version: {path.name}")
        if not BUILDER_PATTERN.fullmatch(builder):
            raise PublicationError(f"artifact has an invalid builder revision: {path.name}")
        return target, version, builder
    raise PublicationError(f"artifact target is not approved for publication: {path.name}")


def _validate_archive_envelope(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not members:
                raise PublicationError(f"artifact archive is empty: {path.name}")
            top_levels: set[str] = set()
            names: set[str] = set()
            for member in members:
                name = PurePosixPath(member.filename)
                if (
                    member.filename in names
                    or name.is_absolute()
                    or not name.parts
                    or ".." in name.parts
                ):
                    raise PublicationError(
                        f"artifact archive has an unsafe or duplicate member: {path.name}"
                    )
                names.add(member.filename)
                top_levels.add(name.parts[0])
            if top_levels != {path.stem}:
                raise PublicationError(
                    f"artifact archive top-level directory does not match its identity: {path.name}"
                )
    except zipfile.BadZipFile as error:
        raise PublicationError(f"artifact is not a valid zip archive: {path.name}") from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(DOWNLOAD_BLOCK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def discover_artifacts(
    directory: Path, github_sha: str, workflow_ref: str
) -> list[Artifact]:
    if not SHA_PATTERN.fullmatch(github_sha):
        raise PublicationError("GITHUB_SHA must be a lowercase 40-character commit")
    workflow_name = _workflow_name(workflow_ref)
    allowed_targets = TARGETS_BY_WORKFLOW[workflow_name]
    default_version = _load_default_version()
    paths = sorted(directory.rglob("*.zip"))
    if not paths:
        raise PublicationError(f"no ONNX Runtime archives were downloaded beneath {directory}")

    artifacts: list[Artifact] = []
    seen_targets: set[str] = set()
    for path in paths:
        target, version, builder = _parse_archive_name(path)
        if target not in allowed_targets:
            raise PublicationError(
                f"{workflow_name} is not allowed to publish target {target!r}"
            )
        if target in seen_targets:
            raise PublicationError(f"more than one archive was downloaded for target {target!r}")
        if version != default_version:
            raise PublicationError(
                f"artifact version {version!r} is not the source-lock default {default_version!r}"
            )
        if builder != github_sha[:12]:
            raise PublicationError(
                f"artifact builder {builder!r} does not match GITHUB_SHA {github_sha[:12]!r}"
            )
        _validate_archive_envelope(path)
        size = path.stat().st_size
        if size == 0 or size > MAX_SINGLE_PUT_BYTES:
            raise PublicationError(
                f"artifact size {size} is outside R2's single-PutObject range: {path.name}"
            )
        key = f"onnxruntime/{target}/{path.name}"
        artifacts.append(
            Artifact(path, target, version, builder, key, size, _sha256(path))
        )
        seen_targets.add(target)
    return artifacts


def _json_request(request: urllib.request.Request, description: str) -> dict:
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise PublicationError(f"{description} returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise PublicationError(f"{description} failed: {error.reason}") from error
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublicationError(f"{description} returned invalid JSON") from error
    if not isinstance(value, dict):
        raise PublicationError(f"{description} returned a non-object JSON response")
    return value


def request_github_oidc_token(environment: Mapping[str, str]) -> str:
    request_url = _required_environment("ACTIONS_ID_TOKEN_REQUEST_URL", environment)
    request_token = _required_environment("ACTIONS_ID_TOKEN_REQUEST_TOKEN", environment)
    parsed = urllib.parse.urlsplit(request_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("audience", BROKER_AUDIENCE))
    url = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {request_token}", "Accept": "application/json"},
    )
    response = _json_request(request, "GitHub OIDC token endpoint")
    token = response.get("value")
    if not isinstance(token, str) or not token:
        raise PublicationError("GitHub OIDC token endpoint omitted the token value")
    return token


def request_publication_grant(
    artifact: Artifact, oidc_token: str, environment: Mapping[str, str]
) -> PublicationGrant:
    broker_url = environment.get("WFLOAT_ONNXRUNTIME_CREDENTIALS_URL", BROKER_AUDIENCE)
    request = urllib.request.Request(
        broker_url,
        data=json.dumps({"key": artifact.key}, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {oidc_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    response = _json_request(request, "ONNX Runtime credential broker")
    credential = response.get("credential")
    if not isinstance(credential, dict):
        raise PublicationError("credential broker omitted the temporary credential")
    required = {
        "endpoint": response.get("endpoint"),
        "bucket": response.get("bucket"),
        "key": response.get("key"),
        "public_url": response.get("public_url"),
        "access_key_id": credential.get("access_key_id"),
        "secret_access_key": credential.get("secret_access_key"),
        "session_token": credential.get("session_token"),
    }
    if any(not isinstance(value, str) or not value for value in required.values()):
        raise PublicationError("credential broker response is missing required fields")
    if required["key"] != artifact.key:
        raise PublicationError("credential broker returned a different object key")
    if required["public_url"] != f"{PUBLIC_ORIGIN}/{artifact.key}":
        raise PublicationError("credential broker returned an invalid public URL")
    return PublicationGrant(
        endpoint=required["endpoint"],
        bucket=required["bucket"],
        key=required["key"],
        public_url=required["public_url"],
        credential=TemporaryCredential(
            required["access_key_id"],
            required["secret_access_key"],
            required["session_token"],
        ),
    )


def _aws_environment(grant: PublicationGrant) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(
        {
            "AWS_ACCESS_KEY_ID": grant.credential.access_key_id,
            "AWS_SECRET_ACCESS_KEY": grant.credential.secret_access_key,
            "AWS_SESSION_TOKEN": grant.credential.session_token,
            "AWS_DEFAULT_REGION": "auto",
            "AWS_REGION": "auto",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_PAGER": "",
            "AWS_CLI_AUTO_PROMPT": "off",
            "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
            "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
            "AWS_RETRY_MODE": "standard",
            "AWS_MAX_ATTEMPTS": "3",
        }
    )
    return environment


def _aws_request(
    operation: str,
    grant: PublicationGrant,
    arguments: list[str] | None = None,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    command = [
        "aws",
        "--endpoint-url",
        grant.endpoint,
        "--no-cli-pager",
        "--output",
        "json",
        "s3api",
        operation,
        "--bucket",
        grant.bucket,
        "--key",
        grant.key,
        *(arguments or []),
    ]
    try:
        return subprocess.run(
            command,
            env=_aws_environment(grant),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PublicationError(f"AWS CLI {operation} failed: {error}") from error


def _download_public_sha256(url: str, expected_size: int) -> str:
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/zip",
                    "User-Agent": "wfloat-onnxruntime-publisher",
                },
            )
            digest = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(request, timeout=120) as response:
                for block in iter(lambda: response.read(DOWNLOAD_BLOCK_BYTES), b""):
                    digest.update(block)
                    size += len(block)
            if size != expected_size:
                raise PublicationError(
                    f"public object size {size} does not match local artifact size {expected_size}"
                )
            return digest.hexdigest()
        except (OSError, urllib.error.URLError, PublicationError) as error:
            last_error = error
            if attempt < 4:
                time.sleep(2**attempt)
    raise PublicationError(f"unable to verify the public registry object: {last_error}")


def publish_artifact(artifact: Artifact, grant: PublicationGrant) -> str:
    if grant.key != artifact.key:
        raise PublicationError("publication grant does not match the artifact key")
    head = _aws_request("head-object", grant)
    if head.returncode == 0:
        result = "already existed"
    elif any(marker in head.stderr for marker in ["(404)", "Not Found", "NoSuchKey"]):
        put = _aws_request(
            "put-object",
            grant,
            [
                "--body",
                str(artifact.path),
                "--cache-control",
                "public, max-age=31536000, immutable",
                "--content-type",
                "application/zip",
                "--if-none-match",
                "*",
            ],
            timeout=1200,
        )
        if put.returncode == 0:
            result = "created"
        elif any(
            marker in put.stderr
            for marker in ["(409)", "(412)", "ConditionalRequestConflict", "PreconditionFailed"]
        ):
            result = "won by a concurrent publisher"
        else:
            raise PublicationError(f"R2 PutObject failed: {put.stderr.strip()[:500]}")
    else:
        raise PublicationError(f"R2 HeadObject failed: {head.stderr.strip()[:500]}")

    public_sha256 = _download_public_sha256(grant.public_url, artifact.size)
    if public_sha256 != artifact.sha256:
        raise PublicationError(
            f"immutable object {artifact.key} has SHA-256 {public_sha256}; "
            f"local artifact has {artifact.sha256}"
        )
    return result


def main(argv: list[str] | None = None, environment: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Publish successful ONNX Runtime CI archives to Wfloat's immutable registry"
    )
    parser.add_argument("artifact_directory", type=Path)
    args = parser.parse_args(argv)
    env = os.environ if environment is None else environment

    try:
        if env.get("GITHUB_EVENT_NAME") != "push" or env.get("GITHUB_REF") != "refs/heads/main":
            raise PublicationError("registry publication is restricted to pushes on main")
        github_sha = _required_environment("GITHUB_SHA", env)
        workflow_ref = _required_environment("GITHUB_WORKFLOW_REF", env)
        if not shutil.which("aws"):
            raise PublicationError("the GitHub-hosted publisher runner is missing AWS CLI v2")
        artifacts = discover_artifacts(args.artifact_directory, github_sha, workflow_ref)
        failures: list[str] = []
        for artifact in artifacts:
            try:
                print(
                    f"Publishing {artifact.key} ({artifact.size} bytes, SHA-256 {artifact.sha256})",
                    flush=True,
                )
                oidc_token = request_github_oidc_token(env)
                grant = request_publication_grant(artifact, oidc_token, env)
                result = publish_artifact(artifact, grant)
                print(f"Verified {artifact.key}: {result}", flush=True)
            except PublicationError as error:
                failures.append(artifact.key)
                print(f"error: {artifact.key}: {error}", file=sys.stderr, flush=True)
        if failures:
            raise PublicationError(
                f"publication failed for {len(failures)} artifact(s): {', '.join(failures)}"
            )
        return 0
    except PublicationError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

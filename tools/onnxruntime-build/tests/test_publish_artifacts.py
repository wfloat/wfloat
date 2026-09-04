from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unittest
import urllib.parse
import zipfile
from pathlib import Path
from unittest import mock

try:
    from . import test_ci_selection
except ImportError:
    import test_ci_selection


PUBLISHER = test_ci_selection._load(
    "publish_artifacts",
    test_ci_selection.REPOSITORY / "scripts" / "publish_onnxruntime_artifacts.py",
)
SHA = "a" * 40
BUILDER = SHA[:12]
WORKFLOW_REF = (
    "wfloat/wfloat/.github/workflows/"
    "onnxruntime-builder-linux.yml@refs/heads/main"
)


def _archive(directory: Path, target: str, builder: str = BUILDER) -> Path:
    path = directory / f"onnxruntime-{target}-1.29.0-{builder}.zip"
    with zipfile.ZipFile(path, "w") as output:
        output.writestr(f"{path.stem}/LICENSE", "license")
    return path


def _artifact(path: Path, target: str = "linux-x64-glibc2_17"):
    return PUBLISHER.Artifact(
        path=path,
        target=target,
        version="1.29.0",
        builder=BUILDER,
        key=f"onnxruntime/{target}/{path.name}",
        size=path.stat().st_size,
        sha256=PUBLISHER._sha256(path),
    )


def _grant(artifact):
    return PUBLISHER.PublicationGrant(
        endpoint="https://abc.r2.cloudflarestorage.com",
        bucket="registry",
        key=artifact.key,
        public_url=f"https://registry.wfloat.com/{artifact.key}",
        credential=PUBLISHER.TemporaryCredential("access", "secret", "session"),
    )


class ArtifactDiscoveryTest(unittest.TestCase):
    def test_discovers_only_current_commit_archives_owned_by_the_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = _archive(root, "linux-x64-glibc2_17")
            second = _archive(root, "linux-aarch64-glibc2_17")

            artifacts = PUBLISHER.discover_artifacts(root, SHA, WORKFLOW_REF)
            self.assertEqual([artifact.path for artifact in artifacts], [second, first])
            self.assertEqual(
                {artifact.target for artifact in artifacts},
                {"linux-x64-glibc2_17", "linux-aarch64-glibc2_17"},
            )
            for artifact in artifacts:
                self.assertEqual(artifact.builder, BUILDER)
                self.assertEqual(artifact.version, "1.29.0")
                self.assertEqual(
                    artifact.sha256,
                    hashlib.sha256(artifact.path.read_bytes()).hexdigest(),
                )
                self.assertEqual(
                    artifact.key, f"onnxruntime/{artifact.target}/{artifact.path.name}"
                )

    def test_rejects_another_family_or_stale_builder_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _archive(root, "android")
            with self.assertRaisesRegex(PUBLISHER.PublicationError, "not allowed"):
                PUBLISHER.discover_artifacts(root, SHA, WORKFLOW_REF)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _archive(root, "linux-x64-glibc2_17", "b" * 12)
            with self.assertRaisesRegex(PUBLISHER.PublicationError, "does not match"):
                PUBLISHER.discover_artifacts(root, SHA, WORKFLOW_REF)

    def test_rejects_duplicate_targets_and_an_invalid_archive_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _archive(root, "linux-x64-glibc2_17")
            nested = root / "copy"
            nested.mkdir()
            _archive(nested, "linux-x64-glibc2_17")
            with self.assertRaisesRegex(PUBLISHER.PublicationError, "more than one"):
                PUBLISHER.discover_artifacts(root, SHA, WORKFLOW_REF)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / f"onnxruntime-linux-x64-glibc2_17-1.29.0-{BUILDER}.zip"
            with zipfile.ZipFile(path, "w") as output:
                output.writestr("wrong-top/LICENSE", "license")
            with self.assertRaisesRegex(PUBLISHER.PublicationError, "top-level"):
                PUBLISHER.discover_artifacts(root, SHA, WORKFLOW_REF)


class BrokerAndSigningTest(unittest.TestCase):
    def test_requests_a_github_token_for_the_broker_audience(self) -> None:
        environment = {
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.example/token?job=1",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "request-token",
        }
        with mock.patch.object(
            PUBLISHER, "_json_request", return_value={"value": "oidc-token"}
        ) as request:
            self.assertEqual(
                PUBLISHER.request_github_oidc_token(environment), "oidc-token"
            )
        actual = request.call_args.args[0]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(actual.full_url).query)
        self.assertEqual(query["audience"], [PUBLISHER.BROKER_AUDIENCE])
        self.assertEqual(actual.headers["Authorization"], "Bearer request-token")

    def test_accepts_only_a_grant_for_the_requested_exact_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            response = {
                "endpoint": "https://abc.r2.cloudflarestorage.com",
                "bucket": "registry",
                "key": artifact.key,
                "public_url": f"https://registry.wfloat.com/{artifact.key}",
                "credential": {
                    "access_key_id": "access",
                    "secret_access_key": "secret",
                    "session_token": "session",
                },
            }
            with mock.patch.object(PUBLISHER, "_json_request", return_value=response):
                grant = PUBLISHER.request_publication_grant(artifact, "token", {})
            self.assertEqual(grant.key, artifact.key)

            response["key"] = "onnxruntime/android/other.zip"
            with mock.patch.object(PUBLISHER, "_json_request", return_value=response):
                with self.assertRaisesRegex(PUBLISHER.PublicationError, "different object key"):
                    PUBLISHER.request_publication_grant(artifact, "token", {})

    def test_aws_cli_receives_temporary_credentials_without_github_oidc_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            completed = subprocess.CompletedProcess([], 0, "{}", "")
            with mock.patch.dict(
                PUBLISHER.os.environ,
                {
                    "ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.example/token",
                    "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "request-token",
                },
            ):
                with mock.patch.object(
                    PUBLISHER.subprocess, "run", return_value=completed
                ) as run:
                    PUBLISHER._aws_request(
                        "put-object",
                        _grant(artifact),
                        ["--body", str(artifact.path), "--if-none-match", "*"],
                    )
        command = run.call_args.args[0]
        environment = run.call_args.kwargs["env"]
        self.assertIn("--endpoint-url", command)
        self.assertIn("put-object", command)
        self.assertIn("--if-none-match", command)
        self.assertNotIn("access", command)
        self.assertNotIn("secret", command)
        self.assertNotIn("session", command)
        self.assertEqual(environment["AWS_ACCESS_KEY_ID"], "access")
        self.assertEqual(environment["AWS_SECRET_ACCESS_KEY"], "secret")
        self.assertEqual(environment["AWS_SESSION_TOKEN"], "session")
        self.assertEqual(environment["AWS_REQUEST_CHECKSUM_CALCULATION"], "when_required")
        self.assertNotIn("ACTIONS_ID_TOKEN_REQUEST_URL", environment)
        self.assertNotIn("ACTIONS_ID_TOKEN_REQUEST_TOKEN", environment)


class PublicationTest(unittest.TestCase):
    def test_existing_object_is_hash_verified_without_a_put(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            with mock.patch.object(
                PUBLISHER,
                "_aws_request",
                return_value=subprocess.CompletedProcess([], 0, "{}", ""),
            ) as request, mock.patch.object(
                PUBLISHER,
                "_download_public_sha256",
                return_value=artifact.sha256,
            ):
                result = PUBLISHER.publish_artifact(artifact, _grant(artifact))
        self.assertEqual(result, "already existed")
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[0], "head-object")

    def test_missing_object_is_conditionally_created_and_verified(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            with mock.patch.object(
                PUBLISHER,
                "_aws_request",
                side_effect=[
                    subprocess.CompletedProcess([], 1, "", "An error occurred (404)"),
                    subprocess.CompletedProcess([], 0, "{}", ""),
                ],
            ) as request, mock.patch.object(
                PUBLISHER,
                "_download_public_sha256",
                return_value=artifact.sha256,
            ):
                result = PUBLISHER.publish_artifact(artifact, _grant(artifact))
        self.assertEqual(result, "created")
        put = request.call_args_list[1]
        self.assertEqual(put.args[0], "put-object")
        self.assertIn("--if-none-match", put.args[2])
        self.assertNotIn("--metadata", put.args[2])

    def test_conditional_creation_race_verifies_the_winning_object(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            with mock.patch.object(
                PUBLISHER,
                "_aws_request",
                side_effect=[
                    subprocess.CompletedProcess([], 1, "", "An error occurred (404)"),
                    subprocess.CompletedProcess(
                        [], 1, "", "An error occurred (PreconditionFailed) (412)"
                    ),
                ],
            ), mock.patch.object(
                PUBLISHER,
                "_download_public_sha256",
                return_value=artifact.sha256,
            ) as download:
                result = PUBLISHER.publish_artifact(artifact, _grant(artifact))
        self.assertEqual(result, "won by a concurrent publisher")
        download.assert_called_once_with(
            f"https://registry.wfloat.com/{artifact.key}", artifact.size
        )

    def test_existing_object_with_different_bytes_is_a_hard_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = _artifact(_archive(Path(temporary), "linux-x64-glibc2_17"))
            with mock.patch.object(
                PUBLISHER,
                "_aws_request",
                return_value=subprocess.CompletedProcess([], 0, "{}", ""),
            ), mock.patch.object(
                PUBLISHER, "_download_public_sha256", return_value="f" * 64
            ):
                with self.assertRaisesRegex(PUBLISHER.PublicationError, "local artifact"):
                    PUBLISHER.publish_artifact(artifact, _grant(artifact))

    def test_manual_or_pull_request_execution_cannot_publish(self) -> None:
        for event in ["workflow_dispatch", "pull_request"]:
            with mock.patch.object(PUBLISHER, "request_github_oidc_token") as oidc:
                result = PUBLISHER.main(
                    ["unused"],
                    {"GITHUB_EVENT_NAME": event, "GITHUB_REF": "refs/heads/main"},
                )
            self.assertEqual(result, 1)
            oidc.assert_not_called()

    def test_one_publication_failure_does_not_block_a_successful_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = _artifact(
                _archive(root, "linux-aarch64-glibc2_17"),
                "linux-aarch64-glibc2_17",
            )
            second = _artifact(_archive(root, "linux-x64-glibc2_17"))
            environment = {
                "GITHUB_EVENT_NAME": "push",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_SHA": SHA,
                "GITHUB_WORKFLOW_REF": WORKFLOW_REF,
            }
            with mock.patch.object(
                PUBLISHER.shutil, "which", return_value="/usr/bin/aws"
            ), mock.patch.object(
                PUBLISHER, "discover_artifacts", return_value=[first, second]
            ), mock.patch.object(
                PUBLISHER,
                "request_github_oidc_token",
                side_effect=["first-token", "second-token"],
            ) as oidc, mock.patch.object(
                PUBLISHER,
                "request_publication_grant",
                side_effect=[_grant(first), _grant(second)],
            ), mock.patch.object(
                PUBLISHER,
                "publish_artifact",
                side_effect=[PUBLISHER.PublicationError("temporary failure"), "created"],
            ) as publish:
                result = PUBLISHER.main([str(root)], environment)

        self.assertEqual(result, 1)
        self.assertEqual(oidc.call_count, 2)
        self.assertEqual(publish.call_count, 2)


if __name__ == "__main__":
    unittest.main()

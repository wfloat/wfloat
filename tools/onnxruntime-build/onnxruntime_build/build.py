from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .catalog import BUILDER_ROOT, SOURCE_LOCK_PATH, Catalog
from .core import (
    BuildContext,
    BuildError,
    base_build_command as _base_build_command,
    capture,
    common_preflight,
    run,
)
from .package import package_target, sha256
from .recipes.android import _sdk_paths as _android_sdk_paths
from .recipes.apple_xcframework import apple_settings as _apple_settings
from .source import acquire_source, verify_microsoft_source_after_build


@dataclass
class BuildResult:
    archive: Path
    microsoft_commit: str
    builder_revision: str
    validation_messages: list[str]


def _builder_revision(require_clean: bool) -> tuple[Path, str]:
    repository = Path(capture(["git", "rev-parse", "--show-toplevel"], cwd=BUILDER_ROOT))
    commit = capture(["git", "rev-parse", "HEAD^{commit}"], cwd=repository).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise BuildError("unable to resolve the Wfloat builder commit")
    if require_clean:
        relative_builder = BUILDER_ROOT.relative_to(repository)
        paths = [
            str(relative_builder),
            ".github/actions/onnxruntime-artifact",
            ".github/workflows/onnxruntime-builder-android.yml",
            ".github/workflows/onnxruntime-builder-apple.yml",
            ".github/workflows/onnxruntime-builder-contracts.yml",
            ".github/workflows/onnxruntime-builder-linux.yml",
            ".github/workflows/onnxruntime-builder-wasm.yml",
            ".github/workflows/onnxruntime-builder-windows.yml",
        ]
        status = capture(
            ["git", "status", "--porcelain", "--untracked-files=normal", "--", *paths],
            cwd=repository,
        )
        if status:
            raise BuildError(
                "builder source/workflows must be committed before an artifact is named; dirty paths:\n"
                + status
            )
        executable_paths = [
            str(relative_builder / "onnxruntime_build"),
            str(relative_builder / "ci"),
        ]
        ignored_status = capture(
            [
                "git",
                "status",
                "--porcelain=v1",
                "--ignored=matching",
                "--untracked-files=all",
                "--",
                *executable_paths,
            ],
            cwd=repository,
        )
        ignored_code = [line for line in ignored_status.splitlines() if line.startswith("!! ")]
        if ignored_code:
            raise BuildError(
                "ignored files must not influence the committed builder identity:\n"
                + "\n".join(ignored_code)
            )
    return repository, commit[:12]


def build_target(
    catalog: Catalog,
    target_id: str,
    version: str,
    jobs: int,
    cache_dir: Path,
    work_dir: Path,
    output_dir: Path,
    source_dir: Path | None = None,
    skip_tests: bool = False,
    plan: bool = False,
) -> BuildResult | None:
    if jobs < 1:
        raise BuildError("--jobs must be at least 1")
    if not plan and catalog.path.resolve() != SOURCE_LOCK_PATH.resolve():
        raise BuildError("real builds require the committed tools/onnxruntime-build/source-lock.json")

    target = catalog.target(target_id)
    recipe = catalog.recipe(target_id)
    source_revision = catalog.source_revision(version)
    _, builder_revision = _builder_revision(require_clean=not plan)
    build_root = work_dir.resolve() / target_id / version / builder_revision

    if target["verification"] == "unverified":
        print(
            f"Target verification: UNVERIFIED ({recipe.name} command and package contract are implemented, "
            "but no completed artifact evidence is recorded)"
        )
    else:
        print("Target verification: VERIFIED by completed local artifact evidence")

    if plan:
        planned_source = source_dir.resolve() if source_dir else Path("/microsoft/onnxruntime")
        context = BuildContext(planned_source, build_root, jobs, skip_tests, True)
        command_plan = recipe.plan(target, context)
        plan_output = {
            "target": target_id,
            "recipe": recipe.name,
            "verification": target["verification"],
            "version": version,
            "source_revision": source_revision,
            "outputs": {key: str(path) for key, path in command_plan.outputs.items()},
            "commands": command_plan.commands,
        }
        print(json.dumps(plan_output, indent=2))
        return None

    resolved_source, microsoft_commit = acquire_source(
        cache_dir=cache_dir,
        version=version,
        source_revision=source_revision,
        jobs=jobs,
        source_dir=source_dir,
    )
    print(f"Microsoft ONNX Runtime source commit: {microsoft_commit}")
    print(f"Wfloat builder revision: {builder_revision}")
    common_preflight(target)
    if recipe.preflight:
        recipe.preflight(target, resolved_source)
    context = BuildContext(resolved_source, build_root, jobs, skip_tests, False)
    command_plan = recipe.plan(target, context)
    for command in command_plan.commands:
        run(command, cwd=resolved_source)

    post_build_commit = verify_microsoft_source_after_build(resolved_source)
    if post_build_commit != source_revision:
        raise BuildError(
            f"Microsoft source changed during the build: expected {source_revision}, found {post_build_commit}"
        )

    archive = package_target(
        target=target,
        version=version,
        builder_revision=builder_revision,
        source_dir=resolved_source,
        outputs=command_plan.outputs,
        package_work_dir=build_root / "package",
        output_dir=output_dir,
    )

    from .validate import validate_archive

    validation = validate_archive(
        catalog,
        target_id,
        archive,
        run_smoke=True,
        source_dir=resolved_source,
        source_was_verified_after_build=True,
    )
    for message in validation:
        print(message)
    print(f"Archive: {archive}")
    print(f"SHA-256: {sha256(archive)}")
    return BuildResult(
        archive=archive,
        microsoft_commit=microsoft_commit,
        builder_revision=builder_revision,
        validation_messages=validation,
    )

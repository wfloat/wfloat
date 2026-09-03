from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from .build import BuildError, build_target
from .catalog import BUILDER_ROOT, Catalog, CatalogError
from .source import SourceError
from .validate import ValidationError, validate_archive


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _parser(catalog: Catalog) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="onnxruntime-build",
        description="Build and validate Wfloat ONNX Runtime C/C++ artifacts.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    list_parser = commands.add_parser("list", help="List declarative build inputs")
    list_commands = list_parser.add_subparsers(dest="list_command", required=True)
    targets_parser = list_commands.add_parser("targets", help="List supported target identifiers")
    targets_parser.add_argument("--platform", choices=sorted({target["platform"] for target in catalog.targets()}))
    targets_parser.add_argument("--json", action="store_true", help="Emit resolved target definitions as JSON")

    build_parser = commands.add_parser("build", help="Build and validate one exact ONNX Runtime target")
    build_parser.add_argument("target", choices=catalog.target_ids)
    build_parser.add_argument(
        "--version",
        default=catalog.default_version,
        help=f"Cataloged ONNX Runtime version (default: {catalog.default_version})",
    )
    build_parser.add_argument(
        "--source-dir",
        type=Path,
        help="Use an existing Microsoft checkout at the cataloged commit",
    )
    build_parser.add_argument("--jobs", type=_positive_integer, default=max(1, min(8, os.cpu_count() or 1)))
    build_parser.add_argument("--cache-dir", type=Path, default=BUILDER_ROOT / ".cache" / "sources")
    build_parser.add_argument("--work-dir", type=Path, default=BUILDER_ROOT / ".build")
    build_parser.add_argument("--output-dir", type=Path, default=BUILDER_ROOT / ".out")
    build_parser.add_argument("--skip-tests", action="store_true", help="Report and skip Microsoft tests")
    build_parser.add_argument("--plan", action="store_true", help="Print resolved Microsoft build commands only")

    validate_parser = commands.add_parser("validate", help="Validate an existing target archive")
    validate_parser.add_argument("target", choices=catalog.target_ids)
    validate_parser.add_argument("archive", type=Path)
    validate_parser.add_argument(
        "--source-dir",
        type=Path,
        help="Pinned Microsoft checkout used to locate cross-toolchain validators",
    )
    validate_parser.add_argument("--skip-smoke", action="store_true", help="Skip the compile/link C API smoke test")
    return parser


def _list_targets(catalog: Catalog, platform: str | None, as_json: bool) -> int:
    targets = catalog.targets(platform)
    if as_json:
        print(json.dumps(targets, indent=2, sort_keys=True))
        return 0
    headings = (
        "TARGET",
        "RECIPE",
        "PLATFORM",
        "ARCHITECTURE(S)",
        "LINKAGE",
        "PROVIDERS",
    )
    rows: list[tuple[str, ...]] = []
    for target in targets:
        architectures = target.get("architectures") or [target.get("architecture", "slices")]
        rows.append(
            (
                target["id"],
                target["recipe"],
                target["platform"],
                ",".join(architectures),
                target["linkage"],
                ",".join(target["providers"]),
            )
        )
    widths = [max(len(headings[index]), *(len(row[index]) for row in rows)) for index in range(len(headings))]
    print("  ".join(value.ljust(widths[index]) for index, value in enumerate(headings)))
    for row in rows:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        catalog = Catalog.load()
        args = _parser(catalog).parse_args(argv)
        if args.command == "list":
            return _list_targets(catalog, args.platform, args.json)
        if args.command == "build":
            build_target(
                catalog=catalog,
                target_id=args.target,
                version=args.version,
                jobs=args.jobs,
                cache_dir=args.cache_dir,
                work_dir=args.work_dir,
                output_dir=args.output_dir,
                source_dir=args.source_dir,
                skip_tests=args.skip_tests,
                plan=args.plan,
            )
            return 0
        if args.command == "validate":
            messages = validate_archive(
                catalog,
                args.target,
                args.archive,
                run_smoke=not args.skip_smoke,
                source_dir=args.source_dir,
            )
            for message in messages:
                print(message)
            print(f"VALID: {args.archive.resolve()}")
            return 0
        raise AssertionError(f"unhandled command {args.command}")
    except (CatalogError, BuildError, SourceError, ValidationError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath


GCC_VERSION = "11.4.0"
GCC_ARCHIVE = f"gcc-{GCC_VERSION}.tar.xz"
GCC_SOURCE_URL = f"https://gcc.gnu.org/pub/gcc/releases/gcc-{GCC_VERSION}/{GCC_ARCHIVE}"
GCC_SOURCE_SHA512 = (
    "a5018bf1f1fa25ddf33f46e720675d261987763db48e7a5fdf4c26d3150a8abcb"
    "82fdc413402df1c32f2e6b057d9bae6bdfa026defc4030e10144a8532e60f14"
)
GCC_PREREQUISITES = (
    "gmp-6.1.0.tar.bz2",
    "mpfr-3.1.6.tar.bz2",
    "mpc-1.0.3.tar.gz",
)
GCC_PREREQUISITE_BASE_URL = "https://gcc.gnu.org/pub/gcc/infrastructure"
DEFAULT_PREFIX = Path(f"/tmp/wfloat-gcc-{GCC_VERSION}")


def _sha512(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, destination: Path, expected_sha512: str) -> None:
    print(f"Downloading {url}", flush=True)
    request = urllib.request.Request(url, headers={"User-Agent": "wfloat-onnxruntime-builder"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open(
        "xb"
    ) as output:
        shutil.copyfileobj(response, output)
    actual = _sha512(destination)
    if actual != expected_sha512:
        raise RuntimeError(
            f"SHA-512 mismatch for {destination.name}: expected {expected_sha512}, found {actual}"
        )


def _prerequisite_hashes(source_dir: Path) -> dict[str, str]:
    checksum_file = source_dir / "contrib" / "prerequisites.sha512"
    hashes: dict[str, str] = {}
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1] in GCC_PREREQUISITES:
            hashes[fields[1]] = fields[0]
    missing = sorted(set(GCC_PREREQUISITES) - hashes.keys())
    if missing:
        raise RuntimeError(f"verified GCC source lacks prerequisite checksums: {missing}")
    return hashes


def _extract_gcc(archive: Path, workspace: Path) -> Path:
    expected_root = f"gcc-{GCC_VERSION}"
    with tarfile.open(archive, "r:xz") as bundle:
        roots = {
            PurePosixPath(member.name).parts[0]
            for member in bundle.getmembers()
            if PurePosixPath(member.name).parts
        }
        if roots != {expected_root}:
            raise RuntimeError(f"unexpected GCC archive roots: {sorted(roots)}")
        bundle.extractall(workspace, filter="data")
    source_dir = workspace / expected_root
    if not (source_dir / "gcc" / "BASE-VER").is_file():
        raise RuntimeError("verified GCC archive did not contain gcc/BASE-VER")
    return source_dir


def _run(command: list[str], cwd: Path) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def _installed_version(prefix: Path) -> str | None:
    compiler = prefix / "bin" / "gcc"
    if not compiler.is_file():
        return None
    return subprocess.run(
        [compiler, "-dumpfullversion"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()


def install(prefix: Path, jobs: int) -> None:
    installed = _installed_version(prefix)
    if installed == GCC_VERSION:
        print(f"Using existing GCC {GCC_VERSION} at {prefix}", flush=True)
        return
    if prefix.exists():
        raise RuntimeError(f"refusing partial or unexpected GCC installation at {prefix}")

    with tempfile.TemporaryDirectory(prefix="wfloat-gcc-build-") as workspace_name:
        workspace = Path(workspace_name)
        archive = workspace / GCC_ARCHIVE
        _download(GCC_SOURCE_URL, archive, GCC_SOURCE_SHA512)
        source_dir = _extract_gcc(archive, workspace)

        prerequisite_hashes = _prerequisite_hashes(source_dir)
        for name in GCC_PREREQUISITES:
            _download(
                f"{GCC_PREREQUISITE_BASE_URL}/{name}",
                source_dir / name,
                prerequisite_hashes[name],
            )
        _run(["./contrib/download_prerequisites", "--no-isl"], source_dir)

        build_dir = workspace / "build"
        build_dir.mkdir()
        _run(
            [
                str(source_dir / "configure"),
                f"--prefix={prefix}",
                "--enable-languages=c,c++",
                "--disable-bootstrap",
                "--disable-libsanitizer",
                "--disable-multilib",
                "--disable-nls",
                "--disable-werror",
                "--without-isl",
            ],
            build_dir,
        )
        _run(["make", f"-j{jobs}"], build_dir)
        _run(["make", "install-strip"], build_dir)

    installed = _installed_version(prefix)
    if installed != GCC_VERSION:
        raise RuntimeError(f"installed GCC reports {installed!r}; expected {GCC_VERSION}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install Wfloat's pinned manylinux GCC")
    parser.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    parser.add_argument("--jobs", type=int, default=4)
    arguments = parser.parse_args()
    if arguments.jobs < 1:
        parser.error("--jobs must be at least 1")
    install(arguments.prefix, arguments.jobs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

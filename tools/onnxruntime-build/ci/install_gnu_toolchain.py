#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
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
BINUTILS_VERSION = "2.42"
BINUTILS_ARCHIVE = f"binutils-{BINUTILS_VERSION}.tar.xz"
BINUTILS_SOURCE_URL = f"https://ftp.gnu.org/gnu/binutils/{BINUTILS_ARCHIVE}"
BINUTILS_SOURCE_SHA512 = (
    "155f3ba14cd220102f4f29a4f1e5cfee3c48aa03b74603460d05afb73c70d665"
    "7a9d87eee6eb88bf13203fe6f31177a5c9addc04384e956e7da8069c8ecd20a6"
)
GCC_PREREQUISITES = (
    "gmp-6.1.0.tar.bz2",
    "mpfr-3.1.6.tar.bz2",
    "mpc-1.0.3.tar.gz",
)
GCC_PREREQUISITE_BASE_URL = "https://gcc.gnu.org/pub/gcc/infrastructure"
DEFAULT_PREFIX = Path(
    f"/tmp/wfloat-gnu-toolchain-gcc-{GCC_VERSION}-binutils-{BINUTILS_VERSION}"
)
BINUTILS_VERSION_PATTERNS = {
    "as": r"GNU assembler .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "ld": r"GNU ld .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "ar": r"GNU ar .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "nm": r"GNU nm .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "ranlib": r"GNU ranlib .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "strip": r"GNU strip .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "objdump": r"GNU objdump .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "readelf": r"GNU readelf .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "gcc-ar": r"GNU ar .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "gcc-nm": r"GNU nm .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
    "gcc-ranlib": r"GNU ranlib .*?([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
}
EXPECTED_TOOL_VERSIONS = {
    "gcc": GCC_VERSION,
    "g++": GCC_VERSION,
    **{name: BINUTILS_VERSION for name in BINUTILS_VERSION_PATTERNS},
}


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


def _extract_archive(
    archive: Path,
    workspace: Path,
    expected_root: str,
    required_file: PurePosixPath,
) -> Path:
    with tarfile.open(archive, "r:*") as bundle:
        roots = {
            PurePosixPath(member.name).parts[0]
            for member in bundle.getmembers()
            if PurePosixPath(member.name).parts
        }
        if roots != {expected_root}:
            raise RuntimeError(
                f"unexpected {archive.name} archive roots: {sorted(roots)}"
            )
        bundle.extractall(workspace, filter="data")
    source_dir = workspace / expected_root
    if not (source_dir / required_file).is_file():
        raise RuntimeError(
            f"verified {archive.name} did not contain {required_file.as_posix()}"
        )
    return source_dir


def _extract_gcc(archive: Path, workspace: Path) -> Path:
    return _extract_archive(
        archive,
        workspace,
        f"gcc-{GCC_VERSION}",
        PurePosixPath("gcc/BASE-VER"),
    )


def _extract_binutils(archive: Path, workspace: Path) -> Path:
    return _extract_archive(
        archive,
        workspace,
        f"binutils-{BINUTILS_VERSION}",
        PurePosixPath("gas/as.c"),
    )


def _run(command: list[str], cwd: Path) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def _installed_versions(prefix: Path) -> dict[str, str] | None:
    versions: dict[str, str] = {}
    for compiler_name in ("gcc", "g++"):
        compiler = prefix / "bin" / compiler_name
        if not compiler.is_file():
            return None
        try:
            versions[compiler_name] = subprocess.run(
                [compiler, "-dumpfullversion"],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    for tool_name, pattern in BINUTILS_VERSION_PATTERNS.items():
        tool = prefix / "bin" / tool_name
        if not tool.is_file():
            return None
        try:
            output = subprocess.run(
                [tool, "--version"],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            ).stdout
        except (OSError, subprocess.CalledProcessError):
            return None
        match = re.search(pattern, output)
        if not match:
            return None
        versions[tool_name] = match.group(1)
    return versions


def install(prefix: Path, jobs: int) -> None:
    installed = _installed_versions(prefix)
    expected = EXPECTED_TOOL_VERSIONS
    if installed == expected:
        print(
            f"Using existing GCC {GCC_VERSION} and binutils {BINUTILS_VERSION} at {prefix}",
            flush=True,
        )
        return
    if prefix.exists():
        raise RuntimeError(
            f"refusing partial or unexpected GNU toolchain installation at {prefix}"
        )

    with tempfile.TemporaryDirectory(prefix="wfloat-gnu-toolchain-build-") as workspace_name:
        workspace = Path(workspace_name)
        binutils_archive = workspace / BINUTILS_ARCHIVE
        _download(BINUTILS_SOURCE_URL, binutils_archive, BINUTILS_SOURCE_SHA512)
        binutils_source_dir = _extract_binutils(binutils_archive, workspace)

        binutils_build_dir = workspace / "binutils-build"
        binutils_build_dir.mkdir()
        _run(
            [
                str(binutils_source_dir / "configure"),
                f"--prefix={prefix}",
                "--disable-gdb",
                "--disable-gdbserver",
                "--disable-gold",
                "--disable-gprofng",
                "--disable-nls",
                "--disable-shared",
                "--disable-sim",
                "--disable-werror",
                "--enable-deterministic-archives",
            ],
            binutils_build_dir,
        )
        _run(["make", f"-j{jobs}", "MAKEINFO=/bin/true"], binutils_build_dir)
        _run(["make", "MAKEINFO=/bin/true", "install-strip"], binutils_build_dir)

        gcc_archive = workspace / GCC_ARCHIVE
        _download(GCC_SOURCE_URL, gcc_archive, GCC_SOURCE_SHA512)
        gcc_source_dir = _extract_gcc(gcc_archive, workspace)

        prerequisite_hashes = _prerequisite_hashes(gcc_source_dir)
        for name in GCC_PREREQUISITES:
            _download(
                f"{GCC_PREREQUISITE_BASE_URL}/{name}",
                gcc_source_dir / name,
                prerequisite_hashes[name],
            )
        _run(["./contrib/download_prerequisites", "--no-isl"], gcc_source_dir)

        gcc_build_dir = workspace / "gcc-build"
        gcc_build_dir.mkdir()
        _run(
            [
                str(gcc_source_dir / "configure"),
                f"--prefix={prefix}",
                "--enable-languages=c,c++",
                "--disable-bootstrap",
                "--disable-libsanitizer",
                "--disable-multilib",
                "--disable-nls",
                "--disable-werror",
                f"--with-as={prefix / 'bin' / 'as'}",
                f"--with-ld={prefix / 'bin' / 'ld'}",
                "--without-isl",
            ],
            gcc_build_dir,
        )
        _run(["make", f"-j{jobs}"], gcc_build_dir)
        _run(["make", "install-strip"], gcc_build_dir)

    installed = _installed_versions(prefix)
    if installed != expected:
        raise RuntimeError(
            f"installed GNU toolchain reports {installed!r}; expected {expected!r}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install Wfloat's pinned manylinux GCC and binutils"
    )
    parser.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    parser.add_argument("--jobs", type=int, default=4)
    arguments = parser.parse_args()
    if arguments.jobs < 1:
        parser.error("--jobs must be at least 1")
    install(arguments.prefix, arguments.jobs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

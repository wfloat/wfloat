from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path
from typing import Iterable


class PackageError(RuntimeError):
    pass


def artifact_name(target: dict, version: str, builder_revision: str) -> str:
    return f"onnxruntime-{target['family']}-{version}-{builder_revision}"


def _copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        if destination.exists() or destination.is_symlink():
            destination.unlink()
        destination.symlink_to(os.readlink(source))
    else:
        shutil.copy2(source, destination)


def _copy_framework_binary_as_archive(source: Path, destination: Path) -> None:
    framework = next(
        (parent for parent in source.parents if parent.suffix == ".framework"),
        None,
    )
    if framework is None:
        raise PackageError("Apple static build did not produce an onnxruntime.framework binary")
    try:
        resolved_source = source.resolve(strict=True)
        resolved_source.relative_to(framework.resolve(strict=True))
    except (OSError, RuntimeError, ValueError) as error:
        raise PackageError(
            "Apple framework binary is missing or resolves outside its framework"
        ) from error
    if not resolved_source.is_file():
        raise PackageError("Apple framework binary does not resolve to a regular file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(resolved_source, destination)


def _copy_toolchain_runtime_notices(target: dict, destination: Path) -> None:
    toolchain = target.get("toolchain", {})
    names = toolchain.get("runtime_license_files", [])
    if not names:
        return
    source_dir_value = toolchain.get("runtime_license_dir")
    if not source_dir_value:
        raise PackageError("static toolchain runtime has no license directory")
    expected_hashes = toolchain.get("runtime_license_sha256", {})
    if set(expected_hashes) != set(names):
        raise PackageError("static toolchain runtime notice hashes are incomplete")
    source_dir = Path(source_dir_value)
    for name in names:
        source = source_dir / name
        if not source.is_file() or source.is_symlink():
            raise PackageError(f"static toolchain runtime notice is missing: {source}")
        actual_sha256 = sha256(source)
        if actual_sha256 != expected_hashes[name]:
            raise PackageError(
                f"static toolchain runtime notice {name} has SHA-256 {actual_sha256}; "
                f"expected {expected_hashes[name]}"
            )
        target_notice = destination / "licenses" / name
        target_notice.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target_notice)


def copy_public_headers(source_dir: Path, destination: Path, providers: Iterable[str]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    session_dir = source_dir / "include" / "onnxruntime" / "core" / "session"
    headers = sorted(session_dir.glob("onnxruntime_*.h")) + sorted(session_dir.glob("onnxruntime_*.inc"))
    headers.extend(
        [
            source_dir / "include" / "onnxruntime" / "core" / "framework" / "provider_options.h",
            source_dir / "include" / "onnxruntime" / "core" / "providers" / "cpu" / "cpu_provider_factory.h",
        ]
    )
    for provider in providers:
        if provider in {"cpu", "cuda", "rocm"}:
            continue
        provider_dir = source_dir / "include" / "onnxruntime" / "core" / "providers" / provider
        if provider_dir.is_dir():
            headers.extend(sorted(provider_dir.glob("*.h")))
    for header in headers:
        if header.is_file():
            _copy_file(header, destination / header.name)

    if "cuda" in providers:
        provider_root = source_dir / "include" / "onnxruntime" / "core" / "providers"
        for relative in [Path("resource.h"), Path("custom_op_context.h")]:
            source = provider_root / relative
            if source.is_file():
                _copy_file(source, destination / "core" / "providers" / relative)
        cuda_dir = provider_root / "cuda"
        if cuda_dir.is_dir():
            for header in sorted(cuda_dir.glob("*.h")):
                _copy_file(header, destination / "core" / "providers" / "cuda" / header.name)

    required = [destination / "onnxruntime_c_api.h", destination / "onnxruntime_cxx_api.h"]
    missing = [path.name for path in required if not path.is_file()]
    if missing:
        raise PackageError(f"Microsoft source is missing required public headers: {', '.join(missing)}")


def _candidate_roots(build_dir: Path) -> list[Path]:
    roots = [build_dir / "Release" / "Release", build_dir / "Release", build_dir]
    return [root for root in roots if root.is_dir()]


def _find_named_file(build_dirs: Iterable[Path], name: str) -> Path:
    matches: list[Path] = []
    for build_dir in build_dirs:
        for root in _candidate_roots(build_dir):
            matches.extend(path for path in root.rglob(name) if path.is_file() or path.is_symlink())
    if not matches:
        raise PackageError(f"build output does not contain {name}")
    return sorted(set(matches), key=lambda path: (len(path.parts), str(path)))[0]


def _find_patterns(build_dirs: Iterable[Path], patterns: Iterable[str]) -> list[Path]:
    matches: list[Path] = []
    for build_dir in build_dirs:
        for root in _candidate_roots(build_dir):
            for pattern in patterns:
                matches.extend(path for path in root.rglob(pattern) if path.is_file() or path.is_symlink())
    unique: dict[str, Path] = {}
    for path in sorted(set(matches), key=lambda item: (len(item.parts), str(item))):
        unique.setdefault(path.name, path)
    return list(unique.values())


def _cmake_archiver(build_dir: Path) -> str:
    cache_files = [build_dir / "Release" / "CMakeCache.txt", build_dir / "CMakeCache.txt"]
    for cache_file in cache_files:
        if not cache_file.is_file():
            continue
        for line in cache_file.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("CMAKE_AR:FILEPATH="):
                archiver = line.partition("=")[2]
                if archiver:
                    return archiver
    return shutil.which("ar") or "ar"


def merge_static_archives(build_dirs: Iterable[Path], destination: Path) -> None:
    build_dirs = list(build_dirs)
    excluded = re.compile(r"(?:test|benchmark|gtest|gmock|protoc)", re.IGNORECASE)
    archives: list[Path] = []
    for build_dir in build_dirs:
        release_dir = build_dir / "Release"
        if release_dir.is_dir():
            archives.extend(
                path
                for path in release_dir.rglob("*.a")
                if path.is_file() and not excluded.search(path.name)
            )
    archives = sorted(set(archives))
    if not archives:
        raise PackageError("static build produced no archives to bundle")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    commands = [f"CREATE {destination}"]
    commands.extend(f"ADDLIB {archive}" for archive in archives)
    commands.extend(["SAVE", "END", ""])
    result = subprocess.run(
        [_cmake_archiver(build_dirs[0]), "-M"],
        input="\n".join(commands),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0 or not destination.is_file():
        raise PackageError(f"unable to bundle static ONNX Runtime archive:\n{result.stdout}")


def _copy_standard_libraries(target: dict, build_dirs: list[Path], destination: Path) -> None:
    lib_dir = destination / "lib"
    lib_dir.mkdir(parents=True, exist_ok=True)
    linkage = target["linkage"]
    platform = target["platform"]

    if linkage == "static" and platform not in {"windows", "wasm", "macos"}:
        merge_static_archives(build_dirs, lib_dir / "libonnxruntime.a")
        return
    if platform == "wasm":
        source = _find_named_file(build_dirs, "libonnxruntime_webassembly.a")
        _copy_file(source, lib_dir / "libonnxruntime.a")
        return
    if platform == "macos" and linkage == "static":
        framework_binary = _find_named_file(build_dirs, "onnxruntime")
        _copy_framework_binary_as_archive(
            framework_binary,
            lib_dir / "libonnxruntime.a",
        )
        return

    if platform == "windows":
        if linkage == "static":
            libraries = _find_patterns(build_dirs, ["*.lib"])
            libraries = [path for path in libraries if not re.search(r"test|benchmark|gtest|gmock", path.name, re.I)]
        else:
            patterns = ["onnxruntime*.dll", "onnxruntime*.lib"]
            if "directml" in target["providers"]:
                patterns.extend(["DirectML*.dll", "dxcompiler.dll", "dxil.dll"])
            libraries = _find_patterns(build_dirs, patterns)
    elif platform == "macos":
        libraries = _find_patterns(build_dirs, ["libonnxruntime*.dylib*"])
    else:
        libraries = _find_patterns(build_dirs, ["libonnxruntime*.so*"])
    if not libraries:
        raise PackageError(f"{target['id']} build produced no packageable libraries")
    for library in libraries:
        _copy_file(library, lib_dir / library.name)


def _copy_android(target: dict, outputs: dict[str, Path], destination: Path, source_dir: Path) -> None:
    copy_public_headers(source_dir, destination / "headers", target["providers"])
    for abi in target["architectures"]:
        try:
            build_dir = outputs[abi]
        except KeyError as error:
            raise PackageError(f"Android build output is missing ABI {abi}") from error
        library = _find_named_file([build_dir], "libonnxruntime.so")
        _copy_file(library, destination / "jni" / abi / "libonnxruntime.so")


def _copy_xcframework(outputs: dict[str, Path], destination: Path) -> None:
    build_dir = next(iter(outputs.values()))
    source = build_dir / "framework_out" / "onnxruntime.xcframework"
    if not source.is_dir():
        matches = list(build_dir.rglob("onnxruntime.xcframework"))
        if not matches:
            raise PackageError("Apple build produced no onnxruntime.xcframework")
        source = matches[0]
    shutil.copytree(source, destination / "onnxruntime.xcframework", symlinks=True)


def _zip_tree(root: Path, archive: Path) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        archive.unlink()
    paths = [root] + sorted(root.rglob("*"), key=lambda path: path.as_posix())
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in paths:
            relative = path.relative_to(root.parent).as_posix()
            info = zipfile.ZipInfo(relative + ("/" if path.is_dir() and not path.is_symlink() else ""))
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.create_system = 3
            if path.is_symlink():
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                output.writestr(
                    info,
                    os.readlink(path),
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
            elif path.is_dir():
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                output.writestr(
                    info,
                    b"",
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
            else:
                mode = 0o755 if os.access(path, os.X_OK) else 0o644
                info.external_attr = (stat.S_IFREG | mode) << 16
                with path.open("rb") as stream:
                    output.writestr(
                        info,
                        stream.read(),
                        compress_type=zipfile.ZIP_DEFLATED,
                        compresslevel=9,
                    )


def package_target(
    target: dict,
    version: str,
    builder_revision: str,
    source_dir: Path,
    outputs: dict[str, Path],
    package_work_dir: Path,
    output_dir: Path,
) -> Path:
    name = artifact_name(target, version, builder_revision)
    stage_root = package_work_dir.resolve() / name
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)

    _copy_file(source_dir / "LICENSE", stage_root / "LICENSE")
    _copy_file(source_dir / "ThirdPartyNotices.txt", stage_root / "ThirdPartyNotices.txt")
    _copy_toolchain_runtime_notices(target, stage_root)

    kind = target["package"]["kind"]
    if kind == "android":
        _copy_android(target, outputs, stage_root, source_dir)
    elif kind == "xcframework":
        _copy_xcframework(outputs, stage_root)
    else:
        headers_dir = stage_root / target["package"]["headers_dir"]
        copy_public_headers(source_dir, headers_dir, target["providers"])
        _copy_standard_libraries(target, list(outputs.values()), stage_root)

    archive = output_dir.resolve() / f"{name}.zip"
    _zip_tree(stage_root, archive)
    return archive


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

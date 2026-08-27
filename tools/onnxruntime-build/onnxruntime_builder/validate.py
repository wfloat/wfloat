from __future__ import annotations

import os
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from .catalog import Catalog
from .source import SourceError, VERSION_RE, verify_microsoft_source


class ValidationError(RuntimeError):
    pass


def _host() -> str:
    return {"darwin": "macos", "windows": "windows", "linux": "linux"}.get(
        platform.system().lower(), platform.system().lower()
    )


def _host_architecture() -> str:
    machine = platform.machine().lower()
    return {
        "amd64": "x86_64",
        "x64": "x86_64",
        "arm64": "arm64" if _host() == "macos" else "aarch64",
        "aarch64": "aarch64",
        "i386": "x86",
        "i686": "x86",
    }.get(machine, machine)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _safe_extract(archive: Path, destination: Path, expected_top: str) -> Path:
    with zipfile.ZipFile(archive) as source:
        infos = source.infolist()
        if not infos:
            raise ValidationError("archive is empty")
        top_levels: set[str] = set()
        member_names: set[str] = set()
        for info in infos:
            if info.filename in member_names:
                raise ValidationError(f"archive contains duplicate member name: {info.filename!r}")
            member_names.add(info.filename)
            member = PurePosixPath(info.filename)
            if member.is_absolute() or ".." in member.parts or not member.parts:
                raise ValidationError(f"unsafe archive member: {info.filename!r}")
            top_levels.add(member.parts[0])
        if top_levels != {expected_top}:
            raise ValidationError(
                f"archive must contain exactly top-level directory {expected_top!r}; found {sorted(top_levels)!r}"
            )

        extraction_root = destination.resolve()
        for info in infos:
            member = PurePosixPath(info.filename)
            output = destination.joinpath(*member.parts)
            resolved_parent = output.parent.resolve()
            if not resolved_parent.is_relative_to(extraction_root):
                raise ValidationError(f"archive member escapes extraction directory: {info.filename!r}")
            if info.is_dir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            if _is_symlink(info):
                link_target = source.read(info).decode("utf-8")
                if os.path.isabs(link_target):
                    raise ValidationError(f"archive contains absolute symlink: {info.filename!r}")
                resolved_target = (output.parent / link_target).resolve()
                if not resolved_target.is_relative_to(extraction_root):
                    raise ValidationError(f"archive symlink escapes extraction directory: {info.filename!r}")
                output.symlink_to(link_target)
            else:
                with source.open(info) as input_stream, output.open("wb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    output.chmod(mode)
    return destination / expected_top


def _parse_archive_identity(target: dict, archive: Path) -> tuple[str, str]:
    prefix = f"onnxruntime-{target['family']}-"
    if archive.suffix.lower() != ".zip" or not archive.stem.startswith(prefix):
        raise ValidationError(f"archive filename must match {prefix}<version>-<12-hex-builder>.zip")
    identity = archive.stem.removeprefix(prefix)
    try:
        version, builder = identity.rsplit("-", 1)
    except ValueError as error:
        raise ValidationError("archive filename is missing version or builder revision") from error
    if not VERSION_RE.fullmatch(version) or version != version.lower():
        raise ValidationError(f"archive filename has invalid ONNX Runtime version {version!r}")
    if not re.fullmatch(r"[0-9a-f]{12}", builder):
        raise ValidationError("archive filename builder revision must be 12 lowercase hexadecimal characters")
    return version, builder


def _require_file(path: Path, description: str) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValidationError(f"missing or empty {description}: {path}")


def _validate_headers(root: Path) -> None:
    _require_file(root / "onnxruntime_c_api.h", "ONNX Runtime C header")
    _require_file(root / "onnxruntime_cxx_api.h", "ONNX Runtime C++ header")


def _required_libraries(target: dict, root: Path) -> list[Path]:
    libraries: list[Path] = []
    for relative in target["package"].get("required_libraries", []):
        path = root / relative
        _require_file(path, f"required library {relative}")
        libraries.append(path)
    return libraries


def _tool_output(command: list[str]) -> str:
    try:
        return subprocess.run(
            command, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
        ).stdout
    except FileNotFoundError as error:
        raise ValidationError(f"required validation tool is not installed: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        raise ValidationError(f"validation command failed: {' '.join(command)}\n{error.stdout}") from error


def _archive_tools(source_dir: Path | None) -> list[str]:
    candidates: list[str | None] = []
    if source_dir:
        candidates.append(str(source_dir / "cmake" / "external" / "emsdk" / "upstream" / "bin" / "llvm-ar"))
    candidates.extend([shutil.which("llvm-ar"), shutil.which("emar"), shutil.which("ar")])
    tools: list[str] = []
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and candidate not in tools:
            tools.append(candidate)
    return tools


def _object_archive_members(members: list[str]) -> list[str]:
    return [name for name in members if name.rstrip("/").endswith((".o", ".obj", ".bc"))]


def _first_archive_object(archive: Path, temporary: Path, source_dir: Path | None = None) -> Path:
    archivers = _archive_tools(source_dir)
    if not archivers:
        raise ValidationError("ar, llvm-ar, or emar is required to inspect static archives")
    failures: list[str] = []
    for archiver in archivers:
        try:
            members = [
                line.strip()
                for line in _tool_output([archiver, "t", str(archive)]).splitlines()
                if line.strip()
            ]
            object_members = _object_archive_members(members)
            if not object_members:
                failures.append(f"{archiver}: no object members")
                continue
            member = object_members[0]
            subprocess.run(
                [archiver, "x", str(archive), member],
                cwd=temporary,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            member_name = Path(member.rstrip("/")).name
            extracted = temporary / member_name
            if not extracted.is_file():
                matches = list(temporary.rglob(member_name))
                if not matches:
                    failures.append(f"{archiver}: did not extract {member!r}")
                    continue
                extracted = matches[0]
            return extracted
        except (ValidationError, subprocess.CalledProcessError) as error:
            failures.append(f"{archiver}: {error}")
    raise ValidationError(f"unable to inspect an object from {archive}: {'; '.join(failures)}")


def _file_description(binary: Path) -> str:
    return _tool_output(["file", "-Lb", str(binary)]).strip()


def _architecture_matches(architecture: str, description: str) -> bool:
    lowered = description.lower()
    if architecture in {"x64", "x86_64"}:
        return bool(re.search(r"x86[-_ ]?64|amd64", lowered))
    if architecture == "x86":
        return bool(re.search(r"80386|\bi[3-6]86\b|\bx86\b", lowered)) and "x86-64" not in lowered
    if architecture in {"aarch64", "arm64", "arm64-v8a"}:
        return "aarch64" in lowered or "arm64" in lowered
    if architecture in {"arm", "armeabi-v7a"}:
        return ("arm" in lowered or "eabi" in lowered) and "aarch64" not in lowered and "arm64" not in lowered
    if architecture == "riscv64":
        return "risc-v" in lowered and "64" in lowered
    if architecture == "wasm32":
        return "webassembly" in lowered or "wasm" in lowered
    return architecture.lower() in lowered


def _inspect_archive_architecture(archive: Path, architecture: str, source_dir: Path | None = None) -> str:
    if _host() == "macos" and architecture in {"arm64", "x86_64"}:
        output = _tool_output(["lipo", "-archs", str(archive)]).strip()
        if architecture not in output.split():
            raise ValidationError(f"{archive} does not contain {architecture}; lipo reports {output!r}")
        return output
    with tempfile.TemporaryDirectory(prefix="ort-archive-object-") as temporary_name:
        object_file = _first_archive_object(archive, Path(temporary_name), source_dir)
        description = _file_description(object_file)
    if not _architecture_matches(architecture, description):
        raise ValidationError(f"{archive} has wrong architecture for {architecture}: {description}")
    return description


def _check_linkage(binary: Path, target: dict) -> str:
    description = _file_description(binary)
    linkage = target["linkage"]
    if linkage == "static":
        if not any(token in description.lower() for token in ["archive", "library", "webassembly"]):
            raise ValidationError(f"expected static library at {binary}; file reports: {description}")
    elif target["platform"] not in {"windows"}:
        if not any(token in description.lower() for token in ["shared object", "dynamically linked shared library"]):
            raise ValidationError(f"expected shared library at {binary}; file reports: {description}")
    return description


def _check_glibc(binary: Path, maximum: str) -> str:
    readelf = shutil.which("readelf") or shutil.which("llvm-readelf")
    if not readelf:
        raise ValidationError("readelf or llvm-readelf is required for ELF validation")
    output = _tool_output([readelf, "--version-info", str(binary)])
    versions = {(int(major), int(minor)) for major, minor in re.findall(r"GLIBC_([0-9]+)\.([0-9]+)", output)}
    if not versions:
        raise ValidationError(f"unable to find GLIBC symbol versions in {binary}")
    found = max(versions)
    allowed = tuple(int(part) for part in maximum.split(".", 1))
    if found > allowed:
        raise ValidationError(
            f"{binary} requires GLIBC_{found[0]}.{found[1]}, exceeding target maximum GLIBC_{maximum}"
        )
    return f"GLIBC_{found[0]}.{found[1]}"


def _check_android_api(binary: Path, expected: int) -> None:
    readelf = shutil.which("readelf") or shutil.which("llvm-readelf")
    if not readelf:
        raise ValidationError("readelf or llvm-readelf is required for Android minimum-API validation")
    output = _tool_output([readelf, "--notes", str(binary)])
    match = re.search(r"Android ABI:\s*([0-9]+)", output)
    actual: int | None = int(match.group(1)) if match else None
    if actual is None:
        note = re.search(
            r"\.note\.android\.ident.*?description data:\s*([0-9a-fA-F ]+)", output, re.DOTALL
        )
        if note:
            octets = [int(value, 16) for value in note.group(1).split()[:4]]
            if len(octets) == 4:
                actual = int.from_bytes(bytes(octets), "little")
    if actual is None:
        raise ValidationError(f"Android minimum-API note is missing from {binary}")
    if actual != expected:
        raise ValidationError(f"{binary} records Android API {actual}, expected explicit API {expected}")


def _apple_minimum_versions(binary: Path) -> list[str]:
    output = _tool_output(["otool", "-l", str(binary)])
    versions: list[str] = []
    legacy_minimum_command = False
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("cmd "):
            legacy_minimum_command = stripped.split(maxsplit=1)[1].startswith("LC_VERSION_MIN_")
            continue
        match = re.fullmatch(r"minos\s+([0-9]+(?:\.[0-9]+){1,2})", stripped)
        if match:
            versions.append(match.group(1))
            continue
        if legacy_minimum_command:
            match = re.fullmatch(r"version\s+([0-9]+(?:\.[0-9]+){1,2})", stripped)
            if match:
                versions.append(match.group(1))
                legacy_minimum_command = False
    return sorted(set(versions))


def _version_tuple(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def _apple_minimum_versions_by_architecture(
    binary: Path, architectures: list[str]
) -> dict[str, list[str]]:
    if len(architectures) == 1:
        return {architectures[0]: _apple_minimum_versions(binary)}
    with tempfile.TemporaryDirectory(prefix="ort-apple-slice-") as temporary_name:
        temporary = Path(temporary_name)
        versions: dict[str, list[str]] = {}
        for architecture in architectures:
            thin_binary = temporary / f"{architecture}.binary"
            _tool_output(
                ["lipo", str(binary), "-thin", architecture, "-output", str(thin_binary)]
            )
            versions[architecture] = _apple_minimum_versions(thin_binary)
        return versions


def _check_apple_minimum(
    binary: Path,
    maximum: str,
    architectures: list[str] | None = None,
    maximums_by_architecture: dict[str, str] | None = None,
) -> None:
    architectures = architectures or ["binary"]
    maximums_by_architecture = maximums_by_architecture or {}
    versions_by_architecture = _apple_minimum_versions_by_architecture(binary, architectures)
    for architecture, versions in versions_by_architecture.items():
        if not versions:
            raise ValidationError(
                f"otool did not report minimum-platform metadata for {binary} ({architecture})"
            )
        allowed = maximums_by_architecture.get(architecture, maximum)
        if any(_version_tuple(version) > _version_tuple(allowed) for version in versions):
            raise ValidationError(
                f"{binary} {architecture} minimum platform {versions} exceeds declared compatibility {allowed}"
            )


def _xcframework_binary(bundle: Path, entry: dict) -> Path:
    library = bundle / entry["LibraryIdentifier"] / entry["LibraryPath"]
    if library.suffix == ".framework" or library.is_dir():
        binary = library / library.stem
    else:
        binary = library
    _require_file(binary, f"XCFramework slice binary {entry['LibraryIdentifier']}")
    return binary


def _expected_apple_slice(sysroot: str) -> tuple[str, str | None]:
    return {
        "iphoneos": ("ios", None),
        "iphonesimulator": ("ios", "simulator"),
        "macosx": ("macos", None),
        "xros": ("xros", None),
        "xrsimulator": ("xros", "simulator"),
    }[sysroot]


def _validate_xcframework(target: dict, root: Path, inspect_metadata: bool = True) -> list[Path]:
    bundle = root / target["package"]["bundle"]
    if not bundle.is_dir():
        raise ValidationError(f"missing XCFramework bundle: {bundle}")
    info_path = bundle / "Info.plist"
    _require_file(info_path, "XCFramework Info.plist")
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    entries = info.get("AvailableLibraries")
    if not isinstance(entries, list) or not entries:
        raise ValidationError("XCFramework Info.plist has no AvailableLibraries")

    expected: dict[tuple[str, str | None], set[str]] = {}
    minimums: dict[tuple[str, str | None], str] = {}
    sysroots: dict[tuple[str, str | None], str] = {}
    for sysroot, architectures in target["slices"].items():
        key = _expected_apple_slice(sysroot)
        expected[key] = set(architectures)
        minimums[key] = target["minimum_platforms"][sysroot]
        sysroots[key] = sysroot
    actual: dict[tuple[str, str | None], set[str]] = {}
    binaries: list[Path] = []
    for entry in entries:
        key = (entry.get("SupportedPlatform"), entry.get("SupportedPlatformVariant"))
        actual[key] = set(entry.get("SupportedArchitectures", []))
        binary = _xcframework_binary(bundle, entry)
        binaries.append(binary)
        library = bundle / entry["LibraryIdentifier"] / entry["LibraryPath"]
        headers = (
            library / "Headers"
            if library.is_dir()
            else bundle / entry["LibraryIdentifier"] / entry.get("HeadersPath", "Headers")
        )
        _validate_headers(headers)
        if inspect_metadata:
            if key in minimums:
                architecture_minimums = target.get(
                    "minimum_platforms_by_architecture", {}
                ).get(sysroots[key], {})
                _check_apple_minimum(
                    binary,
                    minimums[key],
                    list(entry.get("SupportedArchitectures", [])),
                    architecture_minimums,
                )
            description = _file_description(binary)
            declared_architectures = set(entry.get("SupportedArchitectures", []))
            binary_architectures = set(_tool_output(["lipo", "-archs", str(binary)]).split())
            if binary_architectures != declared_architectures:
                raise ValidationError(
                    f"XCFramework slice {entry['LibraryIdentifier']} declares {declared_architectures} "
                    f"but its binary contains {binary_architectures}"
                )
            if target["linkage"] == "static" and "archive" not in description.lower():
                raise ValidationError(f"XCFramework static slice is not an archive: {binary}: {description}")
            if target["linkage"] == "shared" and "dynamically linked shared library" not in description.lower():
                raise ValidationError(f"XCFramework shared slice is not dynamic: {binary}: {description}")
    if actual != expected:
        raise ValidationError(f"XCFramework slices do not match target; expected {expected}, found {actual}")
    return binaries


def _dumpbin_output(arguments: list[str], binary: Path) -> str:
    dumpbin = shutil.which("dumpbin")
    if not dumpbin:
        raise ValidationError("dumpbin from a Visual Studio developer environment is required")
    return _tool_output([dumpbin, *arguments, str(binary)])


def _validate_windows_metadata(target: dict, libraries: list[Path], root: Path) -> None:
    primary_relative = (
        "lib/onnxruntime.dll"
        if target["linkage"] == "shared"
        else target["package"]["required_libraries"][0]
    )
    primary = root / primary_relative
    headers = _dumpbin_output(["/headers"], primary).lower()
    architecture = target.get("architecture", "arm64x")
    patterns = {
        "x86": ["14c machine", "machine (x86)"],
        "x64": ["8664 machine", "machine (x64)"],
        "arm64": ["aa64 machine", "machine (arm64)"],
        "arm64x": ["arm64x", "arm64ec", "aa64 machine"],
    }[architecture]
    if not any(pattern in headers for pattern in patterns):
        raise ValidationError(f"dumpbin reports the wrong architecture for {target['id']}")
    crt = target.get("crt")
    if crt and target["linkage"] == "static":
        directives = _dumpbin_output(["/directives"], primary).upper()
        expected = "LIBCMT" if crt == "mt" else "MSVCRT"
        if expected not in directives:
            raise ValidationError(f"static package does not advertise the expected /{crt.upper()} CRT ({expected})")
    if crt and target["linkage"] == "shared":
        dependencies = _dumpbin_output(["/dependents"], primary).upper()
        dynamic_crt = "VCRUNTIME" in dependencies or "MSVCP" in dependencies
        if crt == "md" and not dynamic_crt:
            raise ValidationError("/MD package does not depend on the dynamic MSVC runtime")
        if crt == "mt" and dynamic_crt:
            raise ValidationError("/MT package unexpectedly depends on the dynamic MSVC runtime")


def _validate_standard_metadata(
    target: dict, root: Path, libraries: list[Path], source_dir: Path | None = None
) -> None:
    if target["platform"] == "windows":
        _validate_windows_metadata(target, libraries, root)
        return
    primary = libraries[0]
    architectures = target.get("architectures", [target.get("architecture")])
    architectures = [architecture for architecture in architectures if architecture]
    if target["linkage"] == "static":
        for architecture in architectures:
            _inspect_archive_architecture(primary, architecture, source_dir)
    else:
        description = _check_linkage(primary, target)
        for architecture in architectures:
            if not _architecture_matches(architecture, description):
                raise ValidationError(f"{primary} has wrong architecture for {architecture}: {description}")
    if target["platform"] == "linux" and target.get("toolchain", {}).get("glibc") and target["linkage"] == "shared":
        _check_glibc(primary, target["toolchain"]["glibc"])
    if target["platform"] == "android":
        _check_android_api(primary, target["toolchain"]["android_api"])
    if target["platform"] == "macos":
        expected_arches = set(architectures)
        actual_arches = set(_tool_output(["lipo", "-archs", str(primary)]).split())
        if actual_arches != expected_arches:
            raise ValidationError(f"{primary} architectures are {actual_arches}, expected {expected_arches}")
        _check_apple_minimum(primary, target["minimum_platform"])


def _smoke_source(path: Path) -> None:
    path.write_text(
        "#include <onnxruntime_c_api.h>\n"
        "int main(void) { const OrtApiBase* b = OrtGetApiBase(); "
        "return (b && b->GetVersionString && b->GetVersionString()) ? 0 : 1; }\n",
        encoding="utf-8",
    )


def _smoke_test(target: dict, root: Path, source_dir: Path | None) -> str:
    if target["package"]["kind"] in {"android", "xcframework"} or target["platform"] == "ohos":
        return "SKIP compile/link smoke: target cannot be exercised directly on this host"
    architecture = target.get("architecture")
    normalized = "x86_64" if architecture == "x64" else architecture
    if (
        target["platform"] != "wasm"
        and normalized
        and normalized not in {_host_architecture(), "arm64" if _host_architecture() == "aarch64" else ""}
    ):
        return "SKIP compile/link smoke: target architecture cannot execute on this host"

    include_dir = root / target["package"]["headers_dir"]
    lib_dir = root / "lib"
    with tempfile.TemporaryDirectory(prefix="ort-c-api-smoke-") as temporary_name:
        temporary = Path(temporary_name)
        source = temporary / "smoke.cc"
        _smoke_source(source)
        if target["platform"] == "wasm":
            compiler = shutil.which("em++")
            if not compiler and source_dir:
                candidate = source_dir / "cmake" / "external" / "emsdk" / "upstream" / "emscripten" / "em++"
                compiler = str(candidate) if candidate.is_file() else None
            if not compiler:
                return "SKIP compile/link smoke: em++ is not available"
            output = temporary / "smoke.wasm"
            command = [
                compiler,
                str(source),
                f"-I{include_dir}",
                str(lib_dir / "libonnxruntime.a"),
                "-Wl,--no-entry",
                "-sERROR_ON_UNDEFINED_SYMBOLS=1",
                "-o",
                str(output),
            ]
            _tool_output(command)
            _require_file(output, "WebAssembly final-link smoke output")
            return "PASS compile/link smoke (WebAssembly final link)"

        if target["platform"] == "windows":
            if target["linkage"] == "static":
                return "SKIP compile/link smoke: static Windows link requires consumer-selected system libraries"
            compiler = shutil.which("cl")
            if not compiler:
                return "SKIP compile/link smoke: cl is not available"
            output = temporary / "smoke.exe"
            command = [
                compiler,
                "/nologo",
                "/EHsc",
                f"/I{include_dir}",
                str(source),
                "/link",
                f"/LIBPATH:{lib_dir}",
                "onnxruntime.lib",
                f"/OUT:{output}",
            ]
            _tool_output(command)
            if len(target["providers"]) == 1:
                environment = os.environ.copy()
                environment["PATH"] = str(lib_dir) + os.pathsep + environment.get("PATH", "")
                subprocess.run([str(output)], env=environment, check=True)
                return "PASS compile/link/run smoke"
            return "PASS compile/link smoke (GPU/accelerator runtime not executed)"

        compiler = shutil.which("c++") or shutil.which("clang++")
        if not compiler:
            return "SKIP compile/link smoke: C++ compiler is not available"
        output = temporary / "smoke"
        command = [compiler, str(source), f"-I{include_dir}", f"-L{lib_dir}", "-lonnxruntime", "-o", str(output)]
        if target["linkage"] == "shared":
            if _host() == "macos":
                command.append(f"-Wl,-rpath,{lib_dir}")
            else:
                command.append(f"-Wl,-rpath,{lib_dir}")
        elif target["platform"] == "linux":
            command.extend(["-pthread", "-ldl", "-lm"])
        elif target["platform"] == "macos":
            command.extend(
                [
                    "-framework", "CoreML", "-framework", "Foundation", "-framework", "Accelerate",
                    "-framework", "CoreFoundation",
                ]
            )
        _tool_output(command)
        if len(target["providers"]) == 1 or set(target["providers"]) <= {"cpu", "coreml", "xnnpack"}:
            environment = os.environ.copy()
            if target["linkage"] == "shared" and target["platform"] == "linux":
                environment["LD_LIBRARY_PATH"] = str(lib_dir) + os.pathsep + environment.get("LD_LIBRARY_PATH", "")
            subprocess.run([str(output)], env=environment, check=True)
            return "PASS compile/link/run smoke"
        return "PASS compile/link smoke (GPU runtime not executed)"


def validate_archive(
    catalog: Catalog,
    target_id: str,
    archive: Path,
    *,
    run_smoke: bool = True,
    inspect_metadata: bool = True,
    source_dir: Path | None = None,
) -> list[str]:
    target = catalog.target(target_id)
    archive = archive.resolve()
    source_dir = source_dir.resolve() if source_dir else None
    if not archive.is_file():
        raise ValidationError(f"archive does not exist: {archive}")
    version, _ = _parse_archive_identity(target, archive)
    source_revision = catalog.source_revision(version)
    if source_dir:
        try:
            validation_source_revision = verify_microsoft_source(source_dir)
        except SourceError as error:
            raise ValidationError(str(error)) from error
        if validation_source_revision != source_revision:
            raise ValidationError(
                f"validation source checkout is {validation_source_revision}, not cataloged commit "
                f"{source_revision} for {version}"
            )
    messages: list[str] = []
    with tempfile.TemporaryDirectory(prefix="ort-package-validation-") as temporary_name:
        extraction = Path(temporary_name)
        root = _safe_extract(archive, extraction, archive.stem)
        _require_file(root / "LICENSE", "Microsoft LICENSE")
        _require_file(root / "ThirdPartyNotices.txt", "Microsoft ThirdPartyNotices.txt")
        messages.append("PASS archive identity, safe extraction, license, and notices")

        kind = target["package"]["kind"]
        libraries: list[Path] = []
        if kind == "android":
            _validate_headers(root / target["package"]["headers_dir"])
            for abi in target["architectures"]:
                library = root / "jni" / abi / target["package"]["library"]
                _require_file(library, f"Android {abi} library")
                libraries.append(library)
                if inspect_metadata:
                    description = _check_linkage(library, target)
                    if not _architecture_matches(abi, description):
                        raise ValidationError(f"Android {abi} library has wrong architecture: {description}")
                    _check_android_api(library, target["toolchain"]["android_api"])
        elif kind == "xcframework":
            libraries = _validate_xcframework(target, root, inspect_metadata=inspect_metadata)
        else:
            _validate_headers(root / target["package"]["headers_dir"])
            libraries = _required_libraries(target, root)
            if inspect_metadata:
                _validate_standard_metadata(target, root, libraries, source_dir)
        messages.append("PASS required headers, libraries, architecture, and linkage")

        if run_smoke:
            messages.append(_smoke_test(target, root, source_dir))
        else:
            messages.append("SKIP compile/link smoke (--skip-smoke was requested)")
    return messages

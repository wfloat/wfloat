# Provenance

Wfloat independently implemented this artifact builder from Microsoft ONNX
Runtime source, Microsoft documentation and build machinery, platform and
toolchain documentation, and observable Wfloat/Sherpa consumer and package
contracts.

## Implementation inputs

The implementer used only:

- Microsoft ONNX Runtime source, build scripts, documentation, tests, and
  release-package contracts;
- platform SDK, compiler, CMake, execution-provider, and archive-format
  documentation;
- PyPA manylinux images and auditwheel manylinux policy data;
- GNU's GCC 11.4.0 release, published SHA-512, prerequisite checksums, and
  installation documentation;
- GNU's binutils 2.42 release, detached release signature, and installation
  documentation;
- Wfloat's current public source and consumer build contracts; and
- Wfloat's independent-implementation specification describing target names,
  required files, architectures, linkage, and consumer behavior.

The implementer did not inspect or use source, history, workflows, scripts,
patches, diffs, disassembly, or implementation details from
`csukuangfj/onnxruntime-build`, `csukuangfj/onnxruntime-libs`, the removed
Wfloat submodule, or Supertone's derivative builder.

## Microsoft source identity

[`source-lock.json`](source-lock.json) is intentionally small. Its `repository`
must be Microsoft's ONNX Runtime Git repository, `default_version` selects the
CLI default, and `revisions` maps each accepted version to one full lowercase
Microsoft commit. It contains no target definitions or generated metadata.

For v1.29.0 the exact Microsoft tag and committed lock both resolve to:

```text
2e2543fbe9fae542f921d47a72d21d5a4ef0b710
```

A caller cannot override that revision. An existing checkout is accepted only
when all of the following hold:

- `origin` is Microsoft's repository;
- `HEAD` equals the locked commit;
- the superproject has no tracked modifications, untracked files, or ignored
  files;
- every recursive submodule is initialized at the recorded gitlink; and
- every recursive submodule has no tracked modifications, untracked files, or
  ignored files.

Source acquisition rechecks those conditions after recursive submodule update.
Before a builder-owned cached checkout is reused, acquisition first rejects
tracked or ordinary untracked changes, then removes ignored build/tool outputs
from that cache and performs the full check. Caller-supplied checkouts are never
cleaned; any ignored content is rejected. This prevents a checkout with the
right origin and `HEAD`, but modified source, bytecode, generated toolchain, or
submodule contents, from being treated as the exact Microsoft source.

After Microsoft's build commands finish and before packaging reads headers or
notices, the builder rechecks origin, locked `HEAD`, tracked and ordinary
untracked contents, recorded gitlinks, and recursive submodule worktrees.
Ignored outputs created by Microsoft's build machinery are allowed only in
this post-build check; they are removed before the cache can be reused.

## Builder and target identity

Target definitions and Microsoft command plans live together in independently
owned modules under `onnxruntime_build/recipes/`. Shared code owns source
acquisition and integrity, builder identity, process execution, deterministic
archives, notices, extraction safety, CLI behavior, and common validation
primitives.

The archive name contains the first 12 hexadecimal characters of the committed
Wfloat revision containing the builder. A real build refuses dirty builder,
builder-workflow, or shared CI-action paths so that this revision identifies the
source that created the package. The public launcher restarts Python in
isolated, bytecode-free mode before importing recipes for every command. List,
plan, and validation commands
do not impose an executable-path cleanliness policy because they cannot create
an artifact. Before a real non-plan build, the launcher fails closed unless
executable builder paths have no tracked modifications or untracked/ignored
files.

`verification: verified` is reserved for targets backed by a completed artifact
and the checks documented for that contract. It does not claim that every
provider ran on hardware. `unverified` recipes may be inspected or attempted,
but the CLI warns that command-plan coverage is not evidence that the platform
works. CI may build an unverified target to collect evidence, but workflow
selection never promotes catalog verification. At this source lock, ROCm is
not cataloged because Microsoft v1.29.0 lacks the provider and `--use_rocm`;
OpenHarmony is not cataloged because no Microsoft/Wfloat implementation and
completed evidence exist.

## Distributed notices

Every generated archive copies Microsoft's `LICENSE` and
`ThirdPartyNotices.txt` from the exact source checkout. Wfloat's builder source
is distributed under the public repository's MIT license.

## Reproduction and validation

From the identified Wfloat commit, list the resolved target and rebuild it with
the recorded version, platform toolchain, and bounded job count:

```sh
./tools/onnxruntime-build/onnxruntime-build list targets --json
./tools/onnxruntime-build/onnxruntime-build build <target> --version <version> --jobs <jobs>
```

Validate an existing archive with the same public command used by CI:

```sh
./tools/onnxruntime-build/onnxruntime-build validate <target> <archive.zip>
```

Reproduction means rebuilding and satisfying the same source, package,
metadata, linkage, and consumer contracts. Byte-for-byte identity with an
artifact from another build environment or distributor is not claimed or
required. GitHub Actions revalidates a completed zip before uploading it with a
three-day inspection retention. That short-lived CI copy is not registry
publication; publication remains a separate, explicitly approved operation.

The automatic glibc 2.17 builds use architecture-specific manylinux2014 image
digests plus GCC 11.4.0 and GNU binutils 2.42 built from GNU release archives.
The committed binutils SHA-512 was derived only after its official detached
signature verified against GNU's keyring; the installer verifies that digest
on every build. It also verifies GNU's published GCC archive SHA-512 and the
GMP, MPFR, and MPC SHA-512 values carried by that verified GCC release before
building the C/C++ toolchain into the ephemeral container's temporary
directory. GCC is configured to select the pinned assembler and linker. The
installer runs as the hosted runner's unprivileged UID/GID, does not use a
third-party compiler image or moving package repository, and disables GCC's
three-stage bootstrap to keep per-build toolchain construction bounded.
The binutils build also declines to regenerate the release archive's bundled
Info manuals; this does not omit any compiler or binutils program.

Before invoking that repository-owned installer, the host wrapper rejects
dirty, untracked, or ignored executable builder paths; the public launcher
repeats the check inside the container. The recipe then proves the exact
versions and prefix paths of every compiler and binutils program exported to
the build, the compiler's selected assembler/linker paths, the required C++20
library feature, all
AArch64 feature modes, and forced AVX-VNNI assembly/disassembly on x86-64. The
glibc 2.17 targets do not build Microsoft's unit-test targets because an
upstream test-only `endian.h` include collision is incompatible with glibc
2.17; Microsoft's runtime sources remain exact and unmodified. The resulting
shared libraries statically incorporate GCC's C++ and support runtimes so they
do not depend on the host's `libstdc++.so.6` or `libgcc_s.so.1`. Validation
rejects either dynamic runtime dependency and any remaining `GLIBCXX`,
`CXXABI`, or `GCC` version requirement, in addition to enforcing Wfloat's
committed manylinux symbol allow-sets, forbidden-symbol rules, direct
dependency allowlist, package contract, and C API compile/link/run smoke.
The installer derives the GCC GPLv3, Runtime Library Exception, and retained
libstdc++ HP/SGI notices from that same verified GCC source and the package
validator requires their committed SHA-256 identities in each affected
artifact.
Toolchain selection and skipped upstream tests alone do not establish ABI
compatibility.

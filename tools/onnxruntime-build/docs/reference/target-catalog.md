# Target catalog reference

[`targets.json`](../../targets.json) is the single declarative source for target
identity, version-sensitive toolchains, platform slices, package expectations,
and validation policy. Workflows and local commands resolve the same data.

## Catalog root

| Field | Meaning |
| --- | --- |
| `schema_version` | Catalog schema understood by this builder |
| `default_onnxruntime_version` | Exact Microsoft tag version used when `--version` is omitted |
| `source_repository` | Required Microsoft ONNX Runtime Git origin |
| `profiles` | Shared declarative defaults for related targets |
| `targets` | All public target identifiers and their overrides |

Target profiles are deep-merged with target entries. Arrays replace profile
arrays; objects merge recursively. `ort-builder list targets --json` prints the
fully resolved definitions.

## Resolved target fields

| Field | Meaning |
| --- | --- |
| `id` | Command target identifier |
| `family` | Registry/archive family; defaults to `id` |
| `platform` | Package platform |
| `host` | Required primary build host |
| `driver` | Adapter around a Microsoft build entry point |
| `architecture` / `architectures` / `slices` | Target CPU or platform-native slice set |
| `linkage` | `static` or `shared` |
| `providers` | Required ONNX Runtime execution providers |
| `minimum_platform` / `minimum_platforms` | Explicit deployment compatibility |
| `toolchain` | Exact SDK/provider versions and required environment |
| `package` | Archive kind, header location, and required library paths |
| `validation` | Binary format and Microsoft test policy |

## Archive identity

For family `<family>`, ONNX Runtime version `<version>`, and the first 12
hexadecimal characters of the committed Wfloat builder revision `<builder>`:

```text
onnxruntime-<family>-<version>-<builder>.zip
└── onnxruntime-<family>-<version>-<builder>/
```

Every archive is a Release package. `release` is not part of the family or
filename. Non-native bundles use `include/` and `lib/`, except the combined
Android target, which uses common `headers/` and `jni/<abi>/` directories.
Apple XCFramework targets contain `onnxruntime.xcframework`.

Every archive contains the exact Microsoft source revision's `LICENSE` and
`ThirdPartyNotices.txt` at its top level. No checksum, JSON, registry metadata,
or provenance sidecar is part of the package.

## Test policies

| Policy | Behavior |
| --- | --- |
| `native` | Run Microsoft's applicable tests when target architecture matches the host |
| `cross` | Report Microsoft target tests skipped; validate package metadata and link where possible |
| `gpu-compile` | Build and validate provider files/linkage; report runtime validation separately unless matching hardware is available |

The validator never converts a skipped test into a pass.

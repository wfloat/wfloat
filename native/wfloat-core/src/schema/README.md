# Owned portable schema validator

`validator.h` / `validator.cc` implement a strict JSON Schema 2020-12 **subset**.
This is runtime validation, independent of llama.cpp grammar support. A supported
runtime constraint is not a promise that the grammar constrains every token.

## Native integration

Compile `validator.cc` with C++17, adding the existing
`vendor/llama.cpp/vendor` directory to includes for `<nlohmann/json.hpp>`.
No engine library is needed for this validator. This change does not edit builds.

```cpp
#include "schema/validator.h"
auto checked = wfloat::schema::checkSchema(schema);
auto result = wfloat::schema::validate(schema, value);
// Both are nlohmann::json:
// {"valid":false,"issues":[{"code":"invalidValue","message":"...",
//   "instancePath":"/quantity","schemaPath":"/properties/quantity/type"}]}
```

Both APIs return JSON, with an empty issues array on success, otherwise the first
failure. Paths use JSON Pointer escaping; `""` means the root. `validate` always
checks the entire schema first, even unused alternatives/properties/definitions.
Codes: `invalidSchema`, `unsupportedSchema` are developer configuration failures;
`invalidValue` is rejected data; `resourceLimit` is a validation runtime failure.
Do not turn configuration/runtime failures into model correction attempts.
Allocation/JSON parse failures are exceptions owned by the calling bridge.

## Supported vocabulary

- Boolean schemas; empty object; all JSON primitive types; `integer` including
  integral floating values; type arrays (`["string", "null"]` for nullability).
- `properties`, `required`, boolean/schema `additionalProperties`,
  `minProperties`, `maxProperties`. Properties are optional unless required;
  unspecified additional properties are allowed. No insertion/stripping/coercion.
- Single-schema `items`, `minItems`, `maxItems`, deep `uniqueItems`.
- Deep `enum` and `const`, including numeric equality of `1` and `1.0`.
- `minimum`, `maximum`, numeric `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`.
- `minLength`, `maxLength` count Unicode code points, not bytes/UTF-16 units.
- `anyOf`, `allOf`, `oneOf`, `not`. Every branch is schema-checked.
- `$defs` entries are checked but cannot be referenced in this initial subset.
- `$schema` accepts only `https://json-schema.org/draft/2020-12/schema` (or omit).
- Annotations: `title`, `description`, `$comment`, `default`, `examples`,
  `readOnly`, `writeOnly`, `deprecated`. Defaults do not mutate data; read/write
  flags are annotations, not an access-control mechanism.

Every other keyword fails explicitly: notably `$ref`/`$id`, `pattern`, `format`,
`patternProperties`, tuple/`prefixItems`, `contains`, dependencies, conditionals,
and OpenAPI `nullable`. Use a null type union instead. Regex/format support is
intentionally not approximated with locale/platform-dependent regex semantics.
Contradictory but well-formed constraints are valid schemas rejecting all affected
values. Keyword constraints apply only to their corresponding instance type.

## Numeric and resource boundaries

Uses existing nlohmann JSON 3.12.0 integer/unsigned/double storage. Fractional and
out-of-range integer tokens are subject to that parser's binary64 rounding;
arbitrary precision JSON numbers are not promised. Comparisons and `multipleOf`
use exact decimal arithmetic on the **stored value's serialized representation**,
not an epsilon that accepts near-multiples. JS has already rounded unsafe integer
values before they reach native code; applications needing exact large values
should encode them as strings.

Rejects NaN, Infinity, binary/discarded values and invalid UTF-8. Input and schema
JSON are bounded to depth 128 and 100,000 nodes; schema/validation traversal and
deep comparisons have a 100,000-visit budget per phase. Large unique/enum sets can
exceed this budget. Resource failures never count as a successful alternative or
as a successful `not`. These are work limits, not byte-size or wall-time limits;
bridges should apply transport limits appropriate to their environment.

## Provenance

Validator, decimal helpers and schema tests are original Wfloat code, under the
repository MIT license. No validator/converter source or test corpus was copied.
Behavior was implemented against the JSON Schema 2020-12 specification:
https://json-schema.org/draft/2020-12/json-schema-validation and
https://json-schema.org/draft/2020-12/json-schema-core.

The only library used is the already tracked
`vendor/llama.cpp/vendor/nlohmann/json.hpp`, version 3.12.0, copyright 2013–2025
Niels Lohmann, MIT (notices remain intact in that file). SHA-256 inspected:
`aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
No new dependency, install, vendor import or notice removal is involved.

Run `node tests/schema/run.mjs` from the Wfloat repository. It compiles only the
small validator test driver, runs native/JS fixtures, checks TS inference and
removes temporary output. See the web adapter README for optional Zod testing.

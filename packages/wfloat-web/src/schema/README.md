# Optional schema adapter and integration handoff

Original Wfloat MIT code; no runtime Zod imports and no newly installed dependency.
The portable rules live in shared C++; this folder converts supplied Zod schemas,
normalizes validation, preserves parsed-output types and handles cancellation.

## Worker integration (recommended)

```ts
import { prepareSchemaAsync, SchemaValidationError } from './schema/index.js';

// native supplies checkSchema(schema) and validateSchema(schema, value), each
// returning/fulfilling { valid, issues: [{code,message,instancePath,schemaPath}] }.
const prepared = await prepareSchemaAsync(schema, native, { signal });
// Only now expose prepared.jsonSchema to model formatting / constrained decoding.
const parsed = await prepared.parse(rawArguments, { signal });
// Or: {success:true,value:T} | {success:false,issues:SchemaIssue[]}
const result = await prepared.validate(rawArguments, { signal });
```

`prepareSchemaAsync` awaits **real C++ preflight** before returning a prepared
object. No duplicated JS schema-keyword validator and no second main-thread WASM
runtime are needed. Schema JSON is snapshotted before the first await. JS performs
only strict JSON transport checks (cycles, non-JSON data, Unicode, etc.).

Parent changes needed outside this contribution's ownership:

1. Change `LanguageBackend.prepareSchema(schema)` to permit
   `Promise<PreparedSchema>` (its successful object retains `jsonSchema` and
   `parse(value): Promise<unknown>`). Bind it to `prepareSchemaAsync(schema,native)`.
2. Return the generation handle, then await preparation of **all** tool/output
   schemas before admitting this operation to inference/executor scheduling.
   Preserve request ordering and cancellation during this prerequisite. Do not
   interrupt existing work on behalf of an operation whose schemas have not
   passed preflight. Native unsupported-schema failures are asynchronous here;
   synchronous schema conversion errors cannot all be guaranteed by a worker API.
3. Pass the operation signal to preparation/parse, or retain the parent's terminal
   race guard. Late settlements never authorize inference or tool invocation.
4. Catch `SchemaValidationError` for `invalidArguments`/structured corrections.
   `validate()` alternatively returns ordinary invalid-data issues without a throw.
   `SchemaConfigurationError`, parser exceptions, bridge failures and resource
   limits must fail the operation. A catch-all around `parse` must not classify
   developer/validator bugs as invalid model arguments. JSON text parse errors are
   a separate invalid-output path in the orchestration layer.
5. Keep original raw arguments in history; use returned parsed values for execute,
   callbacks/manual tool calls and structured `output`. Keep original answer text.

`prepareSchema` is retained for integrations that genuinely have a synchronous
native `checkSchema` and native `validate`; it is not a substitute for the worker
prerequisite. Missing or malformed native responses fail, never fabricate success.
The C++ names are `wfloat::schema::checkSchema(schema)` and
`wfloat::schema::validate(schema,value)`; the worker name `validateSchema` maps to
that latter function. Both C++ calls return the result object above.

## Types for the parent API

Exported from `schema/index.ts`:

- `SchemaInput = JSONSchema | ZodSchema` is the schema argument constraint.
- `InferSchema<S>` is **parsed output** (Zod `_output`, or conservative literal
  JSON Schema inference). Use for execute/manual arguments and structured output.
- `InferSchemaInput<S>` is accepted input (Zod `_input`). Do not substitute this
  for execution-facing transformed values.
- `PreparedSchema<T>`, `ValidationResult<T>`, `SchemaIssue`,
  `NativeSchemaWorker`, `NativeSchemaValidator`, and the three error classes.

The parent retains ownership of `defineTool`, tool contexts and LLM types. A
signature preserving inferred executor results while schemas drive the arguments:

```ts
function defineTool<const S extends SchemaInput, R extends JsonValue | PromiseLike<JsonValue>>(
  tool: {
    description?: string;
    inputSchema: S;
    execute: (args: InferSchema<NoInfer<S>>, context: ToolExecutionContext) => R;
  },
): typeof tool;
// Add a manual overload accepting {description?: string; inputSchema:S}.
// Infer output from a const S captured by generate options:
// structuredOutput: {schema:S} -> LanguageGeneration<InferSchema<S>>.
```

`NoInfer` prevents executor annotations from weakening schema inference. The
repository's existing TypeScript 5.9 supports it. Literal object `properties` /
`required`, arrays, primitive types, null unions, enum/const and alternatives are
inferred conservatively; dynamic schemas remain unknown. This is not full static
JSON Schema satisfiability analysis. For cross-field intersections, use a precise
Zod schema or narrow validated data in application code.

## Zod compatibility and limitations

Tested against an **already installed** Zod 4.4.3 (classic). Detection requires
Zod's Standard Schema vendor/version plus `safeParseAsync`; conversion uses the
public instance `toJSONSchema({io:'input',target:'draft-2020-12',...})`, or the
public Standard JSON Schema `jsonSchema.input` capability. Calls request errors
for unrepresentable/cyclic input schemas, and inline reused schemas. The converted
JSON is checked by C++ before generation. Zod's nonenumerable `~standard` protocol
metadata is excluded from converted JSON; no schema constraint is dropped.

Input-side conversion preserves `string().transform(Number)` as string input;
`safeParseAsync` supplies the transformed number once. Tests cover nested
transforms, defaults, async refinements/transforms and cancellation. The adapter
clones JSON inputs before parsing, so custom mutation cannot rewrite raw history.
Parser implementation exceptions propagate separately from invalid-data issues.

Older Zod versions without a conversion capability fail with a clear limitation;
there is no `_def` interpreter or automatic converter package. Zod Mini/core,
Zod 3 and unrelated Standard Schema libraries are not promised. Schemas converting
to unsupported native keywords (for example regex/email/format or references)
fail preflight. Arbitrary refinements execute in JS and need not be enforceable
by constrained decoding; they remain real runtime checks. A standalone transform
with no representable accepted-input schema may fail conversion. There is no
claim that all Zod features or every version of these capabilities are supported.

Public API/source references inspected (no adapted code):
https://zod.dev/json-schema and the installed 4.4.3
`v4/classic/schemas.js`, `v4/core/to-json-schema.js`, `v4/core/schemas.js`.
Zod remains supplied/licensed by its consumer (MIT, Colin McDonnell).

## Tests and exact files

Run `node tests/schema/run.mjs` from `wfloat/`. It uses the existing web package's
TypeScript and `clang++` (override `CXX`), compiles a small temporary test binary,
and cleans output. Set `WFLOAT_TEST_ZOD_PATH` to an existing Zod package directory
to run real runtime/type compatibility checks. In this workspace it discovers
`../assets/wfloat-logo-lab/node_modules/zod`. Without Zod the portable/adapter/type
tests still run and the optional compatibility section reports its skip.

New owned files:

- `native/wfloat-core/src/schema/{validator.h,validator.cc,README.md}`
- `packages/wfloat-web/src/schema/{index.ts,types.ts,adapter.ts,README.md}`
- `tests/schema/{native_driver.cc,cases.json,types.test.ts,parent-types.test.ts,run.mjs}`

No existing build file, package manifest, package index or LLM worker was edited.

The separate `parent-types.test.ts` audits the in-progress LLM API without editing
it. Run with the existing tsc, `--strict --skipLibCheck --target ES2020 --module
ESNext --moduleResolution bundler --noEmit tests/schema/parent-types.test.ts`.
At handoff, argument/structured-output inference passes; the test identifies
parent `defineTool` return-type widening and broad `onToolResult.output`.
It is intentionally separate from the passing standalone schema suite until the
parent completes those types.

// SPDX-License-Identifier: MIT
import type { InferSchema, JSONSchema, NativeSchemaResult, NativeSchemaValidator, NativeSchemaWorker, PreparedSchema, SchemaInput, SchemaIssue, ValidationResult, ZodSchema } from './types.js';

export class SchemaConfigurationError extends Error {
  readonly name = 'SchemaConfigurationError';
  constructor(message: string, readonly issues: readonly SchemaIssue[] = []) { super(message); }
}
/** Invalid model data; safe to report as invalidArguments/correction feedback. */
export class SchemaValidationError extends Error {
  readonly name = 'SchemaValidationError';
  constructor(readonly issues: readonly SchemaIssue[]) {
    super(issues.map(issue => `${issue.instancePath || '/'}: ${issue.message}`).join('; '));
  }
}
/** Internal cancellation signal; parent generation resolves its cancelled outcome. */
export class SchemaValidationAbortedError extends Error {
  readonly name = 'SchemaValidationAbortedError';
  constructor() { super('Schema validation cancelled'); }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
const pointer = (path: readonly PropertyKey[]) => path.map(k => '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

/** Strict JSON snapshot, without invoking toJSON/accessors or erasing constraints. */
function snapshot(value: unknown, freeze = false, zodConversion = false): unknown {
  const active = new Set<object>();
  let visits = 0;
  function copy(v: unknown, depth: number): unknown {
    if (++visits > 100000 || depth > 128) throw new TypeError('JSON depth/work limit exceeded');
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = v.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Unpaired Unicode surrogate');
        } else if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError('Unpaired Unicode surrogate');
      }
      return v;
    }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!record(v)) throw new TypeError('Expected finite JSON data');
    if (active.has(v)) throw new TypeError('Cyclic JSON data');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('Expected a plain JSON object');
    active.add(v);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    if (array && Object.keys(v).length !== v.length) throw new TypeError('Sparse arrays and array properties are not JSON');
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      // Zod 4.4 attaches a non-JSON Standard Schema protocol to converted schemas.
      if (zodConversion && key === '~standard' && !descriptor.enumerable) continue;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('JSON must have enumerable string data properties');
      copy(key, depth + 1); // validate property-name Unicode as well
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) throw new TypeError('Unexpected array property');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), writable: true, configurable: true, enumerable: true });
    }
    active.delete(v);
    return freeze ? Object.freeze(result) : result;
  }
  return copy(value, 0);
}
function nativeResult(result: NativeSchemaResult): NativeSchemaResult {
  if (!record(result) || typeof result.valid !== 'boolean' || !Array.isArray(result.issues) ||
      result.valid !== (result.issues.length === 0) || result.issues.some(i => !record(i) ||
        ['code', 'message', 'instancePath', 'schemaPath'].some(k => typeof i[k] !== 'string'))) {
    throw new Error('Invalid native schema validator response');
  }
  return result;
}
function check(result: NativeSchemaResult): void {
  nativeResult(result);
  if (!result.valid) throw new SchemaConfigurationError(result.issues[0].message, result.issues);
}
function isParser(schema: SchemaInput): schema is ZodSchema {
  return record(schema) && typeof schema.safeParseAsync === 'function';
}
function convert(schema: ZodSchema): unknown {
  const object = schema as unknown as Record<string, unknown>;
  const standard = object['~standard'];
  if (!record(standard) || standard.vendor !== 'zod' || standard.version !== 1) {
    throw new SchemaConfigurationError('Unsupported schema parser: expected Zod with Standard Schema version 1');
  }
  // Prefer the public instance method. No inspection of _def or recursive Zod interpretation.
  if (typeof object.toJSONSchema === 'function') {
    return object.toJSONSchema.call(schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'throw', cycles: 'throw', reused: 'inline' });
  }
  const json = standard.jsonSchema;
  if (record(json) && typeof json.input === 'function') return json.input.call(json, { target: 'draft-2020-12', libraryOptions: { unrepresentable: 'throw', cycles: 'throw', reused: 'inline' } });
  throw new SchemaConfigurationError('This Zod version has no accepted-input JSON Schema conversion capability; use a supported Zod version (tested: 4.4.3) or plain JSON Schema');
}
function withCancellation<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new SchemaValidationAbortedError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new SchemaValidationAbortedError()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // Attach rejection handlers even after cancellation, preventing late unhandled rejections.
    work().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function convertSchema(schema: SchemaInput): { jsonSchema: JSONSchema; parser?: ZodSchema } {
  const parser = isParser(schema) ? schema : undefined;
  try { return { jsonSchema: snapshot(parser ? convert(parser) : schema, true, !!parser) as JSONSchema, parser }; }
  catch (error) {
    if (error instanceof SchemaConfigurationError) throw error;
    throw new SchemaConfigurationError(`Cannot convert schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Prepare with an already-available synchronous native checker. */
export function prepareSchema<const S extends SchemaInput>(schema: S, native: NativeSchemaValidator): PreparedSchema<InferSchema<S>> {
  if (!native || typeof native.checkSchema !== 'function' || typeof native.validate !== 'function') {
    throw new SchemaConfigurationError('A native JSON Schema validator is required');
  }
  const { jsonSchema, parser } = convertSchema(schema);
  check(native.checkSchema(jsonSchema));
  return prepared<InferSchema<S>>(jsonSchema, parser, (s, v) => native.validate(s, v));
}

/** Worker prerequisite: await this BEFORE inference, queue side effects or executors.
 * No prepared object/model schema is returned until real native preflight passes.
 * Parent must await preparation for ALL tool and output schemas before proceeding.
 */
export async function prepareSchemaAsync<const S extends SchemaInput>(schema: S, native: NativeSchemaWorker, options: { signal?: AbortSignal } = {}): Promise<PreparedSchema<InferSchema<S>>> {
  if (!native || typeof native.checkSchema !== 'function' || typeof native.validateSchema !== 'function') {
    throw new SchemaConfigurationError('A native schema worker is required');
  }
  const { jsonSchema, parser } = convertSchema(schema);
  return withCancellation(async () => {
    check(await native.checkSchema(jsonSchema));
    return prepared<InferSchema<S>>(jsonSchema, parser, (s, v) => native.validateSchema(s, v));
  }, options.signal);
}

function prepared<T>(jsonSchema: JSONSchema, parser: ZodSchema | undefined, validateNative: NativeSchemaValidator['validate']): PreparedSchema<T> {
  const result: PreparedSchema<T> = {
    jsonSchema,
    async parse(value, options) {
      const parsed = await result.validate(value, options);
      if (!parsed.success) throw new SchemaValidationError(parsed.issues);
      return parsed.value;
    },
    validate(value, options = {}) {
      return withCancellation(async (): Promise<ValidationResult<T>> => {
        let input: unknown;
        try { input = snapshot(value); }
        catch (error) { return { success: false, issues: [{ code: 'invalidValue', message: String(error), instancePath: '', schemaPath: '' }] }; }
        if (parser) {
          // The supplied parser owns refinements/defaults/transforms. Do not validate
          // parsed output against the accepted-input schema, or run transforms twice.
          const result = await parser.safeParseAsync(input);
          if (!record(result) || typeof result.success !== 'boolean') throw new Error('Invalid Zod parser response');
          if (result.success) {
            if (!('data' in result)) throw new Error('Missing Zod parsed output');
            return { success: true, value: result.data as T };
          }
          if (!record(result.error) || !Array.isArray(result.error.issues) || !result.error.issues.length) throw new Error('Missing Zod validation issues');
          return { success: false, issues: result.error.issues.map(issue => ({ code: 'invalidValue', message: issue.message, instancePath: pointer(issue.path ?? []), schemaPath: '' })) };
        }
        const result = nativeResult(await validateNative(jsonSchema, input));
        if (result.valid) return { success: true, value: input as T };
        if (result.issues.some(i => i.code === 'invalidSchema' || i.code === 'unsupportedSchema')) throw new SchemaConfigurationError(result.issues[0].message, result.issues);
        if (result.issues.some(i => i.code !== 'invalidValue')) throw new Error(`Schema validator failure: ${result.issues[0].message}`);
        return { success: false, issues: result.issues };
      }, options.signal);
    },
  };
  return result;
}

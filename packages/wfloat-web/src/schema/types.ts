// SPDX-License-Identifier: MIT
export type JSONSchema = boolean | { readonly [keyword: string]: unknown };

/** Structural Zod interface: no runtime import or dependency on a Zod version. */
export interface ZodSchema<Input = unknown, Output = unknown> {
  readonly _input: Input;
  readonly _output: Output;
  safeParseAsync(value: unknown): Promise<
    { success: true; data: Output } |
    { success: false; error: { issues: readonly { message: string; path?: readonly PropertyKey[] }[] } }
  >;
}
export type SchemaInput = JSONSchema | ZodSchema;

type RequiredKeys<S> = S extends { readonly required: readonly (infer K extends string)[] } ? string extends K ? never : K : never;
type ObjectType<S, P> = {
  -readonly [K in keyof P as K extends RequiredKeys<S> ? K : never]-?: InferJSONSchema<P[K]>;
} & {
  -readonly [K in keyof P as K extends RequiredKeys<S> ? never : K]?: InferJSONSchema<P[K]>;
} & { [K in Exclude<RequiredKeys<S>, keyof P>]: unknown };
type Primitive<T, S> = T extends 'string' ? string : T extends 'number' | 'integer' ? number :
  T extends 'boolean' ? boolean : T extends 'null' ? null :
  T extends 'array' ? S extends { readonly items: infer I } ? InferJSONSchema<I>[] : unknown[] :
  T extends 'object' ? S extends { readonly properties: infer P } ? ObjectType<S, P> & Record<string, unknown> : Record<string, unknown> : unknown;
/** Conservative inference: unconstrained/dynamic schemas remain unknown. */
export type InferJSONSchema<S> = S extends false ? never :
  S extends { readonly const: infer C } ? C :
  S extends { readonly enum: readonly (infer E)[] } ? E :
  S extends { readonly type: infer T } ? Primitive<T extends readonly unknown[] ? T[number] : T, S> :
  S extends { readonly anyOf: readonly (infer A)[] } ? InferJSONSchema<A> :
  S extends { readonly oneOf: readonly (infer A)[] } ? InferJSONSchema<A> : unknown;
/** Parsed output, used by execute, onToolCall and structured output. */
export type InferSchema<S> = S extends { readonly _output: infer O } ? O : InferJSONSchema<S>;
/** Accepted input type; distinct from transformed output. */
export type InferSchemaInput<S> = S extends { readonly _input: infer I } ? I : InferJSONSchema<S>;

export interface SchemaIssue {
  code: string;
  message: string;
  instancePath: string;
  schemaPath: string;
}
export interface NativeSchemaResult { valid: boolean; issues: SchemaIssue[] }
export interface NativeSchemaValidator {
  /** Synchronous preflight is required before scheduling generation. */
  checkSchema(schema: JSONSchema): NativeSchemaResult;
  validate(schema: JSONSchema, value: unknown): NativeSchemaResult | Promise<NativeSchemaResult>;
}
/** Direct structural match for the worker backend; no main-thread WASM needed. */
export interface NativeSchemaWorker {
  checkSchema(schema: JSONSchema): NativeSchemaResult | Promise<NativeSchemaResult>;
  validateSchema(schema: JSONSchema, value: unknown): NativeSchemaResult | Promise<NativeSchemaResult>;
}
export type ValidationResult<T> = { success: true; value: T } | { success: false; issues: SchemaIssue[] };
export interface PreparedSchema<T> {
  readonly jsonSchema: JSONSchema;
  /** Throws SchemaValidationError only for invalid model data. */
  parse(value: unknown, options?: { signal?: AbortSignal }): Promise<T>;
  validate(value: unknown, options?: { signal?: AbortSignal }): Promise<ValidationResult<T>>;
}

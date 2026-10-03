// SPDX-License-Identifier: MIT
import type { InferSchema, InferSchemaInput, SchemaInput, ZodSchema } from '../../packages/wfloat-web/src/schema/types.js';
type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Dynamic = Assert<Equal<InferSchema<SchemaInput>, unknown>>;
type Transform = Assert<Equal<InferSchema<ZodSchema<string, number>>, number>>;
type Input = Assert<Equal<InferSchemaInput<ZodSchema<string, number>>, string>>;
type Nullable = Assert<Equal<InferSchema<{type: readonly ['string','null']}>, string | null>>;
type Enum = Assert<Equal<InferSchema<{enum: readonly ['a','b']}>, 'a' | 'b'>>;
const object = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name'] } as const;
const good: InferSchema<typeof object> = { name: 'N' };
// @ts-expect-error required property is missing
const missing: InferSchema<typeof object> = {};
// @ts-expect-error optional field retains its type
const wrong: InferSchema<typeof object> = { name: 'N', age: '2' };
// @ts-expect-error transformed output is a number
const output: InferSchema<ZodSchema<string, number>> = '3';
// Parent owns defineTool. This signature demonstrates schema-driven contextual
// inference, without executor annotations influencing schema inference.
declare function defineTool<const S extends SchemaInput, R>(tool: { inputSchema: S; execute: (args: InferSchema<NoInfer<S>>) => R }): R;
function typeOnly(schema: ZodSchema<{quantity: string}, {quantity: number}>) {
  const result = defineTool({ inputSchema: schema, execute: args => ({ total: args.quantity * 10 }) });
  const n: number = result.total;
  // @ts-expect-error schema output controls executor arguments
  defineTool({ inputSchema: schema, execute: (args: {quantity: string}) => args });
  return n;
}
void (null as unknown as Dynamic | Transform | Input | Nullable | Enum);
void good; void missing; void wrong; void output; void typeOnly;

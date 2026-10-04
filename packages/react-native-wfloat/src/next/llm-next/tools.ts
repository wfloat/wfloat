import type { InferSchema, SchemaInput } from '../schema/types';
import type { JsonValue, ToolExecutionContext } from './types';

/** Preserve schema inference, including Zod transforms, inside execute. */
export function defineTool<const S extends SchemaInput, O extends JsonValue = JsonValue>(definition: {
  description?: string;
  inputSchema: S;
  execute?: (input: InferSchema<S>, context: ToolExecutionContext) => O | PromiseLike<O>;
}): typeof definition { return definition; }

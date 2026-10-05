import { prepareSchemaAsync } from '../schema/adapter.js';
import type { NativeSchemaWorker, SchemaInput } from '../schema/types.js';
import type { LanguageBackend } from './backend.js';

export function attachSchemas(native: Omit<LanguageBackend, 'prepareSchema'> & NativeSchemaWorker): LanguageBackend {
  return { ...native, prepareSchema: schema => prepareSchemaAsync(schema as SchemaInput, native) };
}

import { prepareSchemaAsync } from '../schema/adapter';
import type { NativeSchemaWorker, SchemaInput } from '../schema/types';
import type { LanguageBackend } from './backend';

export function attachSchemas(native: Omit<LanguageBackend, 'prepareSchema'> & NativeSchemaWorker): LanguageBackend {
  return { ...native, prepareSchema: schema => prepareSchemaAsync(schema as SchemaInput, native) };
}

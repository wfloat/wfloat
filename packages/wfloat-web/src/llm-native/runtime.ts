import { createLlamaModule, type LlamaModule } from '../wasm/wfloat-llama.js';
import type { NativeLoadOptions, NativeRoundEvent, NativeRoundRequest, SchemaValidation } from './types.js';
interface Module extends LlamaModule {
  _wfloat_native_create(path: number, context: number, threads: number, template: number): number;
  _wfloat_native_destroy(model: number): void;
  _wfloat_native_context_size(model: number): number;
  _wfloat_native_count(model: number, request: number): number;
  _wfloat_native_begin(model: number, request: number): number;
  _wfloat_native_step(round: number, cancel: number): number;
  _wfloat_native_round_destroy(round: number): void;
  _wfloat_native_schema(request: number): number;
  _wfloat_native_last_error(): number;
  _wfloat_native_free_string(ptr: number): void;
}
export class NativeRuntime {
  private model = 0;
  private round = 0;
  readonly contextSize: number;
  private constructor(private readonly module: Module, model: number) {
    this.model = model;
    this.contextSize = module._wfloat_native_context_size(model);
  }
  private static string<T>(module: Module, value: string, use: (ptr: number) => T): T {
    const size = module.lengthBytesUTF8(value) + 1;
    const ptr = module._malloc(size);
    if (!ptr) throw new Error('WASM string allocation failed.');
    try { module.stringToUTF8(value, ptr, size); return use(ptr); }
    finally { module._free(ptr); }
  }
  static async load(options: NativeLoadOptions): Promise<NativeRuntime> {
    if (options.numThreads !== undefined && options.numThreads !== 1) throw new Error('This WASM build supports numThreads: 1 only.');
    const module = await createLlamaModule({ ...(options.wasmBinary ? { wasmBinary: options.wasmBinary } : {}), locateFile: path => options.wasmUrl && path.endsWith('.wasm') ? options.wasmUrl : path }) as Module;
    const bytes = new Uint8Array(options.model instanceof Blob ? await options.model.arrayBuffer() : options.model);
    module.FS.writeFile('/model.gguf', bytes);
    try {
      const model = NativeRuntime.string(module, '/model.gguf', path =>
        NativeRuntime.string(module, options.chatTemplate ?? '', template =>
          module._wfloat_native_create(path, options.contextSize, options.numThreads ?? 1, template)));
      if (!model) throw new Error(module.UTF8ToString(module._wfloat_native_last_error()));
      return new NativeRuntime(module, model);
    } finally { module.FS.unlink('/model.gguf'); }
  }
  private json<T>(ptr: number): T {
    if (!ptr) throw new Error(this.module.UTF8ToString(this.module._wfloat_native_last_error()));
    try { return JSON.parse(this.module.UTF8ToString(ptr)) as T; }
    finally { this.module._wfloat_native_free_string(ptr); }
  }
  count(request: NativeRoundRequest): number {
    return NativeRuntime.string(this.module, JSON.stringify(request), p => this.json<number>(this.module._wfloat_native_count(this.model, p)));
  }
  begin(request: NativeRoundRequest): void {
    if (this.round) throw new Error('A native round is already active.');
    this.round = NativeRuntime.string(this.module, JSON.stringify(request), p => this.module._wfloat_native_begin(this.model, p));
    if (!this.round) throw new Error(this.module.UTF8ToString(this.module._wfloat_native_last_error()));
  }
  step(cancel: boolean): NativeRoundEvent[] { return this.json(this.module._wfloat_native_step(this.round, cancel ? 1 : 0)); }
  end(): void { if (this.round) this.module._wfloat_native_round_destroy(this.round); this.round = 0; }
  schema(schema: unknown, value: unknown, validate: boolean): SchemaValidation {
    return NativeRuntime.string(this.module, JSON.stringify({ schema, value, validate }), p => this.json(this.module._wfloat_native_schema(p)));
  }
  unload(): void { this.end(); if (this.model) this.module._wfloat_native_destroy(this.model); this.model = 0; }
}

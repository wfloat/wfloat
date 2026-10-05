import type { LanguageBackend, RoundEvent, RoundRequest } from '../llm-next/backend.js';
import type { NativeBackend, NativeLoadOptions, NativeMessage, NativeRoundEvent, NativeRoundRequest, SchemaValidation, WorkerCommand, WorkerReply } from './types.js';
export type { NativeLoadOptions } from './types.js';
type Pending = { reply(message: WorkerReply): void; fail(error: Error): void };
class WorkerBackend implements NativeBackend {
  contextSize = 0;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private active?: { id: number; settled: Promise<void> };
  private closed = false;
  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.pending.get(event.data.id)?.reply(event.data);
    worker.onerror = event => this.rejectOutstanding(new Error(event.message || 'Native worker failed.'));
    worker.onmessageerror = () => this.rejectOutstanding(new Error('Native worker message could not be decoded.'));
  }
  private rejectOutstanding(error: Error): void {
    // An unassociated error is not proof that the worker is permanently lost.
    // Reject dependent requests and stop their round, without a health diagnosis.
    if (this.active) this.worker.postMessage({ type: 'abort', id: this.active.id });
    for (const pending of this.pending.values()) pending.fail(error);
    this.pending.clear();
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.fail(error);
    this.pending.clear(); this.worker.terminate();
  }
  private rpc(command: Omit<Extract<WorkerCommand, { type: 'load' }>, 'id'> | Omit<Extract<WorkerCommand, { type: 'schema' }>, 'id'> | { type: 'count'; request: NativeRoundRequest } | { type: 'unload' }): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Native backend is unloaded.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { fail: reject, reply: message => {
        this.pending.delete(id);
        if (message.type === 'error') reject(new Error(message.message));
        else if (message.type === 'result') resolve(message.value);
      } });
      try {
        const transfer = new Set<ArrayBuffer>();
        if (command.type === 'load') {
          if (command.options.model instanceof ArrayBuffer) transfer.add(command.options.model);
          for (const file of command.options.modelFiles ?? [])
            if (file.data instanceof ArrayBuffer) transfer.add(file.data);
          const wasm = command.options.wasmBinary?.buffer;
          if (wasm instanceof ArrayBuffer) transfer.add(wasm);
        }
        this.worker.postMessage({ ...command, id }, [...transfer]);
      }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async load(options: NativeLoadOptions): Promise<void> { this.contextSize = await this.rpc({ type: 'load', options }) as number; }
  async countInputTokens(request: NativeRoundRequest): Promise<number> { return await this.rpc({ type: 'count', request }) as number; }
  async checkSchema(schema: unknown): Promise<SchemaValidation> { return await this.rpc({ type: 'schema', schema, validate: false }) as SchemaValidation; }
  async validateSchema(schema: unknown, value: unknown): Promise<SchemaValidation> { return await this.rpc({ type: 'schema', schema, value, validate: true }) as SchemaValidation; }
  async *generateRound(request: NativeRoundRequest, signal?: AbortSignal): AsyncIterable<NativeRoundEvent> {
    if (this.closed) throw new Error('Native backend is unloaded.');
    if (this.active) throw new Error('A round is already active on this model.');
    const id = ++this.sequence;
    const events: NativeRoundEvent[] = [];
    let failure: Error | undefined, done = false, wake: (() => void) | undefined;
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const finish = () => { done = true; settle(); wake?.(); };
    this.active = { id, settled };
    this.pending.set(id, {
      fail: error => { failure = error; finish(); },
      reply: message => {
        if (message.type === 'error') { failure = new Error(message.message); finish(); }
        else if (message.type === 'event') {
          events.push(message.event);
          if (message.event.type === 'done') finish();
          wake?.();
        }
      },
    });
    const abort = () => this.worker.postMessage({ id, type: 'abort' });
    try {
      try { this.worker.postMessage({ id, type: 'generate', request }); }
      catch (error) { finish(); throw error; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      while (!done || events.length) {
        if (events.length) { yield events.shift()!; continue; }
        await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
      }
      if (failure) throw failure;
    } finally {
      signal?.removeEventListener('abort', abort);
      // Early iterator return also ends native work before allowing the next round.
      if (!done && !this.closed) { abort(); await settled; }
      this.pending.delete(id); this.active = undefined;
    }
  }
  async unload(): Promise<void> {
    if (this.closed) return;
    if (this.active) {
      this.worker.postMessage({ type: 'abort', id: this.active.id });
      await this.active.settled;
    }
    try { await this.rpc({ type: 'unload' }); }
    finally { this.fail(new Error('Native backend is unloaded.')); }
  }
}
export async function createNativeBackend(options: NativeLoadOptions, worker?: Worker): Promise<NativeBackend> {
  if (options.signal?.aborted) throw new DOMException('Model loading cancelled.', 'AbortError');
  const backend = new WorkerBackend(worker ?? new Worker(new URL('./llm-native-worker.js', import.meta.url), { type: 'module' }));
  const { signal, ...loadOptions } = options;
  const abort = () => backend.fail(new DOMException('Model loading cancelled.', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await backend.load(loadOptions);
    // Cancellation can run after the worker's reply but before this async
    // continuation. Never resolve a load with an already-terminated backend.
    if (signal?.aborted) throw new DOMException('Model loading cancelled.', 'AbortError');
    return backend;
  } catch (error) { backend.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
}
function normalize(request: RoundRequest): NativeRoundRequest {
  const names = new Map<string, string>();
  const messages: NativeMessage[] = request.messages.map(message => {
    if (message.role === 'tool') return {
      role: 'tool', tool_call_id: message.callId, name: names.get(message.callId),
      content: JSON.stringify(message.status === 'completed' ? message.output :
        { status: message.status, ...('error' in message ? { error: message.error } : {}) }),
    };
    if (message.role !== 'assistant' || typeof message.content === 'string') return { role: message.role, content: message.content as string };
    const result: NativeMessage = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
    for (const part of message.content) {
      if (part.type === 'text') result.content += part.text;
      else if (part.type === 'reasoning') result.reasoning_content += part.text;
      else if (part.type === 'toolCall') {
        names.set(part.id, part.name);
        result.tool_calls!.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.arguments) } });
      }
    }
    return result;
  });
  const { tools, structuredOutput, ...rest } = request;
  return { ...rest, messages,
    ...(tools ? { tools: Object.entries(tools).map(([name, tool]) => ({ type: 'function' as const, function: { name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
    ...(structuredOutput !== undefined ? { jsonSchema: structuredOutput } : {}),
  };
}
/** Parent supplies prepareSchema to complete the public LanguageBackend boundary. */
export async function createLanguageNativeBackend(options: NativeLoadOptions): Promise<Omit<LanguageBackend, 'prepareSchema'> & Pick<NativeBackend, 'checkSchema' | 'validateSchema'>> {
  const native = await createNativeBackend(options);
  let callSerial = 0;
  return {
    contextSize: native.contextSize,
    countInputTokens: request => native.countInputTokens(normalize(request)),
    checkSchema: schema => native.checkSchema(schema),
    validateSchema: (schema, value) => native.validateSchema(schema, value),
    unload: () => native.unload(),
    async *generateRound(request: RoundRequest, signal: AbortSignal): AsyncIterable<RoundEvent> {
      const nativeRequest = normalize(request);
      const historyIds = new Set(nativeRequest.messages.flatMap(message => [
        ...(message.tool_calls ?? []).map(call => call.id),
        ...(message.tool_call_id ? [message.tool_call_id] : []),
      ]));
      for await (const event of native.generateRound(nativeRequest, signal)) {
        if (event.type === 'usage') { yield event; continue; }
        if (event.type === 'warning') { console.warn(event.message); continue; }
        if (event.type === 'toolCall') {
          // Malformed protocol JSON must never become an executable string argument.
          let args: unknown;
          try { args = JSON.parse(event.rawArguments); }
          catch { throw new Error(`Tool ${event.name} emitted malformed JSON arguments.`); }
          // Mistral templates require exactly nine alphanumeric characters.
          // Keep IDs monotonic across rounds and avoid restored history IDs.
          let id: string;
          do {
            id = (++callSerial).toString(36).padStart(9, '0');
            if (id.length !== 9) throw new Error('Tool call ID space exhausted.');
          } while (historyIds.has(id));
          yield { type: 'toolCall', call: { id, name: event.name, arguments: args } };
        } else if (event.type === 'done') {
          yield { type: 'done', stopReason: event.stopReason === 'cancelled' ? 'complete' : event.stopReason,
            inputTokens: event.inputTokens, outputTokens: event.outputTokens,
            ...(event.stopReason === 'contextLimit' ? { contextLimit: { phase: event.inputTokens >= native.contextSize ? 'input' as const : 'generation' as const, capacityTokens: native.contextSize, inputTokens: event.inputTokens } } : {}) };
        } else if (event.type === 'text') yield { type: 'text', text: event.text };
        else yield { type: 'reasoning', text: event.text };
      }
    },
  };
}

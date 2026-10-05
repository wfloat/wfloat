import type { LanguageBackend, RoundEvent, RoundRequest } from '../llm-next/backend';
import type { NativeBackend, NativeLoadOptions, NativeMessage, NativeRoundEvent, NativeRoundRequest, SchemaValidation } from './types';
import { NativeInstance } from './instance';
import { checkAbort } from '../platform/bridge';
export type { NativeLoadOptions } from './types';

class BridgeBackend implements NativeBackend {
  contextSize = 0;
  private active?: { abort: AbortController; settled: Promise<void> };
  constructor(private readonly instance: NativeInstance) {}
  countInputTokens(request: NativeRoundRequest) { return this.instance.call<number>('count', { request }); }
  checkSchema(schema: unknown) { return this.instance.call<SchemaValidation>('schema', { schema, validate: false }); }
  validateSchema(schema: unknown, value: unknown) { return this.instance.call<SchemaValidation>('schema', { schema, value, validate: true }); }
  async *generateRound(request: NativeRoundRequest, signal?: AbortSignal): AsyncIterable<NativeRoundEvent> {
    if (this.active) throw new Error('A round is already active on this model.');
    checkAbort(signal);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const events: NativeRoundEvent[] = [];
    let done = false, failure: unknown, wake: (() => void) | undefined;
    let sawDone = false;
    const settled = this.instance.call<void>('generateRound', { request }, {
      signal: abort.signal,
      onEvent: (event: NativeRoundEvent) => { events.push(event); if (event.type === 'done') sawDone = true; wake?.(); },
    }).catch(error => { failure = error; }).finally(() => { done = true; wake?.(); });
    this.active = { abort, settled };
    if (signal?.aborted) cancel();
    try {
      while (!done || events.length) {
        if (events.length) { yield events.shift()!; continue; }
        await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
      }
      if (failure) throw failure;
      if (!sawDone) throw new Error('Native generation ended without a terminal event.');
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!done) abort.abort();
      // Babel's RN async-generator helper resumes an awaited return() with
      // generator.return(), skipping statements after an await in finally.
      // Keep ownership release inside the awaited promise's cleanup instead.
      await settled.finally(() => { this.active = undefined; });
    }
  }
  async unload() {
    if (this.active) { this.active.abort.abort(); await this.active.settled; }
    await this.instance.unload();
  }
}
export async function createNativeBackend(options: NativeLoadOptions): Promise<NativeBackend> {
  const instance = new NativeInstance();
  try {
    const loaded = await instance.call<{ contextSize: number }>('load', {
      task: 'llm', family: 'llama', modelId: options.modelId, paths: options.paths,
      options: { contextSize: options.contextSize, numThreads: options.numThreads, chatTemplate: options.chatTemplate },
    }, { signal: options.signal });
    if (!Number.isSafeInteger(loaded.contextSize) || loaded.contextSize < 1) throw new Error('Native runtime returned an invalid context size.');
    checkAbort(options.signal);
    const backend = new BridgeBackend(instance); backend.contextSize = loaded.contextSize;
    return backend;
  } catch (error) { await instance.unload().catch(() => {}); throw error; }
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

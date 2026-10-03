import { SchemaValidationError } from '../schema/adapter.js';
import type { InferSchema, SchemaInput } from '../schema/types.js';
import type { LanguageBackend, PreparedSchema, RoundRequest } from './backend';
import type { ToolMap, ToolCallFor, ToolGenerationOptions, AssistantPart, GenerationOptions, GenerationResult, GenerationRound, LanguageGeneration, Message, StopReason, ToolCall, ToolDefinition, ToolMessage } from './types';
import { asError, GenerationError, jsonValue, notify, StopFilter, toolResult } from './util';

const cancelled = Symbol('cancelled');
interface CallState { call: ToolCall; raw: ToolCall; roundIndex: number; started: boolean; outcome?: ToolMessage; definition: ToolDefinition<any> }
interface RoundState { index: number; text: string; assistant?: Extract<Message, { role: 'assistant' }>; parts: AssistantPart[]; outcomes: Array<Message | CallState> }

function validateOptions(options: GenerationOptions): void {
  if (options.reasoning !== undefined && typeof options.reasoning !== 'boolean') throw new TypeError('reasoning must be a boolean.');
  for (const name of ['stopWhen', 'onText', 'onReasoning', 'onRoundStart', 'onToolCall', 'onToolStart', 'onToolResult', 'onToolError', 'onToolCancel', 'onToolValidationError'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} must be a function.`);
  }
  for (const [name, value] of Object.entries({ maxRounds: options.maxRounds, maxTokensPerRound: options.maxTokensPerRound, maxConcurrentTools: options.maxConcurrentTools })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${name} must be a positive integer.`);
  }
  const attempts = options.structuredOutput?.maxCorrectionAttempts;
  if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 0)) throw new TypeError('maxCorrectionAttempts must be a nonnegative integer.');
  for (const [name, allowed] of Object.entries({ toolExecution: ['sequential', 'parallel'], toolExecutionTiming: ['immediate', 'afterGeneration'], toolErrorBehavior: ['continue', 'stop'] })) {
    const value = options[name as keyof GenerationOptions];
    if (value !== undefined && !allowed.includes(value as string)) throw new TypeError(`Invalid ${name}.`);
  }
  if (options.maxConcurrentTools !== undefined && options.toolExecution !== 'parallel') throw new TypeError('maxConcurrentTools requires parallel toolExecution.');
  if (options.stopStrings?.some(s => typeof s !== 'string' || !s.length)) throw new TypeError('stopStrings must contain nonempty strings.');
  const tools = Object.values(options.tools ?? {});
  if (options.structuredOutput && tools.length) throw new TypeError('structuredOutput and tools cannot be combined.');
  if (tools.some(t => t.execute !== undefined) && !tools.every(t => typeof t.execute === 'function')) throw new TypeError('Tools must either all define execute or all be manual.');
  for (const name of ['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty', 'seed'] as const) {
    const value = options[name];
    if (value !== undefined && !Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
  }
  if (options.temperature !== undefined && options.temperature < 0) throw new TypeError('temperature cannot be negative.');
  for (const name of ['topP', 'minP'] as const) if (options[name] !== undefined && (options[name]! < 0 || options[name]! > 1)) throw new TypeError(`${name} must be between zero and one.`);
  if (options.topK !== undefined && (!Number.isInteger(options.topK) || options.topK < 0)) throw new TypeError('topK must be a nonnegative integer.');
  if (options.repetitionPenalty !== undefined && options.repetitionPenalty <= 0) throw new TypeError('repetitionPenalty must be positive.');
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)) throw new TypeError('seed must be an unsigned 32-bit integer.');
  if (options.maxRounds !== undefined && attempts !== undefined && attempts > options.maxRounds - 1) console.warn('Wfloat: maxRounds limits the configured structured-output correction attempts.');
}
function snapshotMessages(messages: readonly Message[]): Message[] {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  // Clone before queueing: edits to the application's conversation affect only future calls.
  const snapshot = structuredClone(messages) as Message[];
  for (const message of snapshot) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new TypeError('Invalid message role.');
    if (message.role !== 'tool' && typeof message.content !== 'string' && !(message.role === 'assistant' && Array.isArray(message.content))) throw new TypeError('Invalid message content.');
    if (message.createdAt !== undefined && typeof message.createdAt !== 'string') throw new TypeError('Message createdAt must be a string.');
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') throw new TypeError('Invalid assistant content part.');
        if (part.type === 'text' || part.type === 'reasoning') {
          if (typeof part.text !== 'string') throw new TypeError('Assistant text must be a string.');
        } else if (part.type === 'toolCall') {
          if (typeof part.id !== 'string' || typeof part.name !== 'string') throw new TypeError('Tool calls require string id and name.');
          jsonValue(part.arguments);
        } else throw new TypeError('Invalid assistant content part type.');
      }
    }
    if (message.role === 'tool') {
      if (typeof message.callId !== 'string') throw new TypeError('Tool messages require a string callId.');
      if (!['completed', 'notExecuted', 'outcomeUnknown', 'failed', 'invalidArguments', 'unknownTool'].includes(message.status)) throw new TypeError('Invalid tool message status.');
      if (message.status === 'completed') jsonValue(message.output);
      else if (message.status === 'failed' || message.status === 'invalidArguments' || message.status === 'unknownTool') {
        if (!message.error || typeof message.error.message !== 'string') throw new TypeError('Tool errors require a string message.');
      }
    }
  }
  return snapshot;
}

/** A model owns one inference queue and one reusable context. */
export class LanguageModel {
  readonly contextSize: number;
  private tail: Promise<void> = Promise.resolve();
  private operations = new Set<GenerationOperation>();
  private closed = false;
  private unloading?: Promise<void>;
  constructor(private readonly backend: LanguageBackend, readonly modelId: string) { this.contextSize = backend.contextSize; }

  generate<const S extends SchemaInput>(messages: readonly Message[], options: Omit<GenerationOptions, 'structuredOutput'> & { structuredOutput: { schema: S; maxCorrectionAttempts?: number } }): LanguageGeneration<InferSchema<S>>;
  generate<const T extends ToolMap>(messages: readonly Message[], options: ToolGenerationOptions<T>): LanguageGeneration<unknown, ToolCallFor<T>>;
  generate(messages: readonly Message[], options?: GenerationOptions): LanguageGeneration;
  generate(messages: readonly Message[], supplied: any = {}): LanguageGeneration {
    const options: GenerationOptions = supplied;
    if (this.closed) throw new Error('The model has been unloaded.');
    validateOptions(options);
    const input = snapshotMessages(messages);
    const opts = { ...options, stopStrings: options.stopStrings?.slice(), tools: options.tools ? Object.fromEntries(Object.entries(options.tools).map(([key, value]) => [key, { ...value }])) : undefined,
      structuredOutput: options.structuredOutput ? { ...options.structuredOutput } : undefined };
    const schemas = new Map<string, Promise<PreparedSchema>>();
    for (const [name, tool] of Object.entries(opts.tools ?? {})) {
      if (!name.trim()) throw new TypeError('Tool names cannot be empty.');
      const prepared = Promise.resolve(this.backend.prepareSchema(tool.inputSchema));
      void prepared.catch(() => {});
      schemas.set(name, prepared);
    }
    const outputSchema = opts.structuredOutput ? Promise.resolve(this.backend.prepareSchema(opts.structuredOutput.schema)) : undefined;
    void outputSchema?.catch(() => {});
    const op = new GenerationOperation(this.backend, input, opts, schemas, outputSchema);
    this.operations.add(op);
    this.tail = this.tail.then(() => op.run()).catch(() => {}).then(() => { this.operations.delete(op); });
    return op;
  }

  async countInputTokens(messages: readonly Message[], options: Pick<GenerationOptions, 'tools' | 'reasoning' | 'structuredOutput'> = {}): Promise<number> {
    if (this.closed) throw new Error('The model has been unloaded.');
    validateOptions(options);
    const input = snapshotMessages(messages);
    const tools = options.tools && Object.fromEntries(await Promise.all(Object.entries(options.tools).map(async ([name, tool]) => [name, { description: tool.description, inputSchema: (await this.backend.prepareSchema(tool.inputSchema)).jsonSchema }])));
    const request: RoundRequest = { messages: input, reasoning: options.reasoning, tools,
      structuredOutput: options.structuredOutput && (await this.backend.prepareSchema(options.structuredOutput.schema)).jsonSchema };
    return this.backend.countInputTokens(request);
  }
  unload(): Promise<void> {
    if (this.unloading) return this.unloading;
    this.closed = true;
    for (const operation of this.operations) operation.cancel();
    this.unloading = this.tail.then(() => this.backend.unload());
    return this.unloading;
  }
}

class GenerationOperation implements LanguageGeneration {
  private schemas = new Map<string, PreparedSchema>();
  private outputSchema?: PreparedSchema;
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private completion: Promise<void>;
  private observed = false;
  get finished(): Promise<void> { this.observed = true; return this.completion; }
  private promise: Promise<GenerationResult>;
  private resolve!: (result: GenerationResult) => void;
  private reject!: (error: unknown) => void;
  private terminal = false;
  private failure: unknown;
  private hasFailure = false;
  private startedAt?: number;
  private roundStates: RoundState[] = [];
  private calls: ToolCall[] = [];
  private ids = new Set<string>();
  private usage = { inputTokens: 0, outputTokens: 0 };
  private running = 0;
  private pending: CallState[] = [];
  private jobs = new Set<Promise<void>>();
  constructor(private backend: LanguageBackend, private input: Message[], private options: GenerationOptions, private preparedTools: Map<string, Promise<PreparedSchema>>, private preparedOutput?: Promise<PreparedSchema>) {
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.completion = this.promise.then(() => undefined);
    // Either promise may be the caller's sole observation path; avoid duplicate unhandled reports.
    void this.promise.catch(() => {}); void this.completion.catch(() => {});
  }
  result(): Promise<GenerationResult> { this.observed = true; return this.promise; }
  cancel(): void {
    if (this.terminal || this.hasFailure || this.signal.aborted) return;
    this.controller.abort();
    if (this.startedAt === undefined) queueMicrotask(() => { if (!this.terminal) this.finish('cancelled'); });
  }
  private fail(error: unknown): void {
    if (this.terminal || this.hasFailure || this.signal.aborted) return;
    this.failure = error; this.hasFailure = true; this.controller.abort();
  }
  private check(): void { if (this.hasFailure) throw this.failure; if (this.signal.aborted) throw cancelled; }
  private async wait<T>(work: PromiseLike<T> | (() => PromiseLike<T>)): Promise<T> {
    this.check();
    // A race against one operation-long promise retains a reaction for every
    // streamed token until cancellation. Remove this wait's listener on either
    // outcome so long generations do not accumulate abandoned races.
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => this.signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        try { this.check(); } catch (error) { reject(error); }
      };
      this.signal.addEventListener('abort', abort, { once: true });
      try {
        const pending = typeof work === 'function' ? work() : work;
        Promise.resolve(pending).then(value => {
          cleanup();
          try { this.check(); resolve(value); } catch (error) { reject(error); }
        }, error => { cleanup(); reject(error); });
      } catch (error) { cleanup(); reject(error); }
    });
  }
  private roundsSnapshot(): GenerationRound[] {
    return this.roundStates.map(round => {
      const newMessages: Message[] = [];
      if (round.assistant) newMessages.push(round.assistant);
      for (const item of round.outcomes) {
        if ('role' in item) newMessages.push(item);
        else if (item.outcome) newMessages.push(item.outcome);
        else if (item.definition.execute) newMessages.push({ role: 'tool', callId: item.call.id, status: item.started ? 'outcomeUnknown' : 'notExecuted', createdAt: new Date().toISOString() });
      }
      return { roundIndex: round.index, text: round.text, newMessages };
    });
  }
  private partial() {
    const rounds = structuredClone(this.roundsSnapshot());
    return { text: rounds[rounds.length - 1]?.text ?? '', newMessages: rounds.flatMap(r => r.newMessages), rounds };
  }
  private finish(stopReason: StopReason, output?: unknown, contextLimit?: GenerationResult['contextLimit']): void {
    if (this.terminal) return;
    this.terminal = true;
    this.resolve({ ...this.partial(), stopReason, toolCalls: this.calls.map(c => ({ ...c })), usage: { ...this.usage }, durationMs: this.startedAt === undefined ? 0 : performance.now() - this.startedAt,
      ...(output !== undefined ? { output } : {}), ...(contextLimit ? { contextLimit } : {}) });
  }
  private append(round: RoundState, type: 'text' | 'reasoning', text: string): void {
    if (!text) return;
    if (!round.assistant) round.assistant = { role: 'assistant', content: round.parts, createdAt: new Date().toISOString() };
    const last = round.parts[round.parts.length - 1];
    if (last?.type === type) last.text += text; else round.parts.push({ type, text });
    if (type === 'text') { round.text += text; notify(this.options.onText, text); }
    else notify(this.options.onReasoning, text);
  }
  private async receiveCall(raw: ToolCall, round: RoundState): Promise<void> {
    if (this.ids.has(raw.id)) throw new Error(`The backend repeated tool invocation ID ${raw.id}.`);
    this.ids.add(raw.id);
    raw = structuredClone(raw);
    if (!round.assistant) round.assistant = { role: 'assistant', content: round.parts, createdAt: new Date().toISOString() };
    round.parts.push({ type: 'toolCall', ...raw });
    const definition = this.options.tools?.[raw.name];
    const schema = this.schemas.get(raw.name);
    // A complete managed request is already part of history while an async
    // schema refinement runs. If interrupted here it is known not to have run;
    // keep its paired outcome without exposing it as a validated actionable call.
    const validating: CallState | undefined = definition?.execute && schema
      ? { call: raw, raw, roundIndex: round.index, started: false, definition } : undefined;
    const outcomeIndex = round.outcomes.length;
    if (validating) round.outcomes.push(validating);
    let parsed: unknown;
    let invalid: { code: 'invalidArguments' | 'unknownTool'; message: string } | undefined;
    if (!definition || !schema) invalid = { code: 'unknownTool', message: `No tool named "${raw.name}" is available.` };
    else {
      try { parsed = await this.wait(() => schema.parse(structuredClone(raw.arguments))); }
      catch (error) { this.check(); if (!(error instanceof SchemaValidationError)) throw error; invalid = { code: 'invalidArguments', message: error.message }; }
    }
    if (invalid) {
      const outcome: ToolMessage = { role: 'tool', callId: raw.id, status: invalid.code, error: { message: invalid.message }, createdAt: new Date().toISOString() };
      if (validating) round.outcomes[outcomeIndex] = outcome;
      else round.outcomes.push(outcome);
      notify(this.options.onToolValidationError, { request: raw, error: invalid, roundIndex: round.index });
      return;
    }
    const call = { ...raw, arguments: parsed };
    this.calls.push(call);
    const state: CallState = validating ?? { call, raw, roundIndex: round.index, started: false, definition: definition! };
    state.call = call;
    if (!validating) round.outcomes.push(state);
    notify(this.options.onToolCall, { call, roundIndex: round.index });
    if (definition!.execute) {
      this.pending.push(state);
      if (this.options.toolExecutionTiming !== 'afterGeneration') this.pump();
    }
  }
  private pump(): void {
    const limit = this.options.toolExecution === 'parallel' ? this.options.maxConcurrentTools ?? Infinity : 1;
    while (!this.signal.aborted && !this.terminal && this.running < limit && this.pending.length) {
      const state = this.pending.shift()!;
      state.started = true; this.running++;
      const event = { call: state.call, roundIndex: state.roundIndex };
      notify(this.options.onToolStart, event);
      if (this.signal.aborted || this.terminal) { state.started = false; this.running--; continue; }
      const job = (async () => {
        let output: unknown;
        try { output = await state.definition.execute!(state.call.arguments, { signal: this.signal, callId: state.call.id, roundIndex: state.roundIndex }); }
        catch (error) {
          if (this.signal.aborted && (error === this.signal.reason || (error instanceof Error && error.name === 'AbortError'))) {
            notify(this.options.onToolCancel, event);
            return;
          }
          const normalized = asError(error);
          state.outcome = { role: 'tool', callId: state.call.id, status: 'failed', error: { message: normalized.message }, createdAt: new Date().toISOString() };
          notify(this.options.onToolError, { ...event, error: normalized });
          if (this.options.toolErrorBehavior === 'stop') this.fail(normalized);
          return;
        }
        try { jsonValue(output); state.outcome = toolResult(state.call, output); }
        catch (error) { notify(this.options.onToolError, { ...event, error: asError(error) }); this.fail(error); return; }
        notify(this.options.onToolResult, { ...event, output });
      })().finally(() => { this.running--; this.jobs.delete(job); this.pump(); });
      this.jobs.add(job);
    }
  }
  private async drain(): Promise<void> {
    this.pump();
    while (this.jobs.size || this.pending.length) { this.check(); await this.wait(Promise.all([...this.jobs])); }
  }
  async run(): Promise<void> {
    if (this.terminal) return;
    if (this.signal.aborted) { this.finish('cancelled'); return; }
    this.startedAt = performance.now();
    let output: unknown;
    let closing: Promise<unknown> | undefined;
    let validation: Promise<unknown> | undefined;
    let validationText: string | undefined;
    try {
      const prepared = await this.wait(Promise.all([...this.preparedTools].map(async ([name, value]) => [name, await value] as const)));
      this.schemas = new Map(prepared);
      if (this.preparedOutput) this.outputSchema = await this.wait(this.preparedOutput);
      const maxRounds = this.options.maxRounds ?? 20;
      let corrections = 0;
      const modelTools = this.options.tools && Object.fromEntries(Object.entries(this.options.tools).map(([name, tool]) => [name, { description: tool.description, inputSchema: this.schemas.get(name)!.jsonSchema }]));
      for (let index = 0; index < maxRounds; index++) {
        this.check();
        validation = undefined; validationText = undefined;
        const past = this.partial().newMessages;
        const round: RoundState = { index, text: '', parts: [], outcomes: [] };
        this.roundStates.push(round);
        notify(this.options.onRoundStart, { roundIndex: index });
        this.check();
        const filter = new StopFilter(this.options.stopStrings ?? []);
        const roundController = new AbortController();
        const abortRound = () => roundController.abort(this.signal.reason);
        this.signal.addEventListener('abort', abortRound, { once: true });
        let stop: StopReason = 'complete';
        let roundInput = 0, roundOutput = 0;
        let contextLimit: GenerationResult['contextLimit'];
        const request: RoundRequest = { messages: [...this.input, ...past], tools: modelTools, reasoning: this.options.reasoning, structuredOutput: this.outputSchema?.jsonSchema,
          maxTokensPerRound: this.options.maxTokensPerRound, temperature: this.options.temperature, topP: this.options.topP, topK: this.options.topK, minP: this.options.minP,
          repetitionPenalty: this.options.repetitionPenalty, presencePenalty: this.options.presencePenalty, frequencyPenalty: this.options.frequencyPenalty, seed: this.options.seed };
        const iterator = this.backend.generateRound(request, roundController.signal)[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await this.wait(() => iterator.next());
            if (next.done) break;
            const event = next.value;
            if (event.type === 'done' || event.type === 'usage') {
              this.usage.inputTokens += event.inputTokens - roundInput; this.usage.outputTokens += event.outputTokens - roundOutput;
              roundInput = event.inputTokens; roundOutput = event.outputTokens;
              if (event.type === 'usage') continue;
              if (stop !== 'stopString') stop = event.stopReason;
              contextLimit = event.contextLimit;
            } else if (stop !== 'stopString') {
              if (event.type === 'text') {
                this.append(round, 'text', filter.push(event.text));
                if (filter.stopped) { stop = 'stopString'; roundController.abort(); }
              } else {
                this.append(round, 'text', filter.flush());
                if (event.type === 'reasoning') this.append(round, 'reasoning', event.text);
                else await this.receiveCall(event.call, round);
              }
            }
          }
        } finally {
          this.signal.removeEventListener('abort', abortRound);
          // Do not wait for an uncooperative worker/executor after cancellation.
          roundController.abort();
          closing = iterator.return?.().catch(() => {});
          this.append(round, 'text', filter.flush());
        }
        if (closing) await this.wait(closing);
        closing = undefined;
        this.append(round, 'text', filter.flush());
        await this.drain();
        this.check();
        const manual = Object.values(this.options.tools ?? {}).some(tool => !tool.execute);
        const snapshot = this.partial();
        const stopRequested = stop === 'complete' && !(manual && round.parts.some(part => part.type === 'toolCall')) && this.options.stopWhen
          ? await this.wait(() => Promise.resolve(this.options.stopWhen!({ messages: structuredClone([...this.input, ...snapshot.newMessages]), rounds: snapshot.rounds, latestRound: snapshot.rounds[snapshot.rounds.length - 1] }))) : false;
        if (typeof stopRequested !== 'boolean') throw new TypeError('stopWhen must return a boolean.');
        if (stopRequested) stop = 'stopCondition';
        if (this.outputSchema) {
          let invalid: unknown;
          try {
            const value = JSON.parse(round.text);
            validationText = round.text;
            validation = Promise.resolve(this.outputSchema.parse(value));
            void validation.catch(() => {});
            output = await this.wait(validation);
          }
          catch (error) { this.check(); if (!(error instanceof SchemaValidationError) && !(error instanceof SyntaxError)) throw error; invalid = error; }
          if (invalid && stop === 'complete') {
            if (corrections >= (this.options.structuredOutput?.maxCorrectionAttempts ?? 0)) throw invalid;
            if (index + 1 >= maxRounds) { this.finish('maxRounds'); return; }
            // Feedback is application-visible and replayable, rather than a hidden prompt mutation.
            round.outcomes.push({ role: 'user', content: `The response did not satisfy the output schema: ${asError(invalid).message}. Return a corrected response.`, createdAt: new Date().toISOString() });
            corrections++; continue;
          }
        }
        if (stop !== 'complete') { this.finish(stop, output, contextLimit); return; }
        if (manual && round.parts.some(part => part.type === 'toolCall')) { this.finish('toolCalls', output); return; }
        if (!round.parts.some(part => part.type === 'toolCall')) { this.finish('complete', output); return; }
      }
      this.finish('maxRounds', output);
    } catch (error) {
      if (error === cancelled && !this.hasFailure) {
        // Cancellation never starts correction inference. Give completed text a
        // bounded validation opportunity; an arbitrary async refinement cannot
        // indefinitely hold a user's Stop action or mutate the terminal result.
        if (this.outputSchema) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const text = this.partial().text;
            if (!validation || validationText !== text) {
              validation = Promise.resolve(this.outputSchema.parse(JSON.parse(text)));
              validationText = text;
            }
            output = await Promise.race([
              validation.catch(() => undefined),
              new Promise<undefined>(resolve => { timer = setTimeout(resolve, 100); }),
            ]);
          } catch { /* Incomplete JSON has no validated output. */ }
          finally { if (timer !== undefined) clearTimeout(timer); }
        }
        this.finish('cancelled', output);
      } else if (!this.terminal) {
        this.fail(error);
        this.terminal = true;
        const cause = this.hasFailure ? this.failure : error;
        const failure = new GenerationError(asError(cause).message, this.partial(), cause);
        this.reject(failure);
        queueMicrotask(() => { if (!this.observed) console.error('Wfloat unobserved generation failure:', failure); });
      }
    } finally {
      // The public outcome is already settled, but keep the model's queue owned
      // until its previous native round has acknowledged cancellation.
      await closing;
    }
  }
}

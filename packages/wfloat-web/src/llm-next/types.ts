/** JSON values suitable for tool results and portable conversation history. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AssistantPart = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: unknown };
export type ToolMessage = { role: 'tool'; callId: string; createdAt?: string } & (
  | { status: 'completed'; output: JsonValue }
  | { status: 'notExecuted' | 'outcomeUnknown' }
  | { status: 'failed' | 'invalidArguments' | 'unknownTool'; error: { message: string } }
);
export type Message =
  | { role: 'system' | 'user'; content: string; createdAt?: string }
  | { role: 'assistant'; content: string | AssistantPart[]; createdAt?: string }
  | ToolMessage;
export interface ToolCall<T = unknown> { id: string; name: string; arguments: T }
export interface ToolExecutionContext { signal: AbortSignal; callId: string; roundIndex: number }
/** Schemas are normalized by the schema adapter before reaching the backend. */
export interface ToolDefinition<T = unknown> {
  description?: string;
  inputSchema: unknown;
  execute?: (input: T, context: ToolExecutionContext) => JsonValue | PromiseLike<JsonValue>;
}
export type ToolMap = Record<string, ToolDefinition<any>>;
export interface GenerationRound { roundIndex: number; text: string; newMessages: Message[] }
export type StopReason = 'complete' | 'toolCalls' | 'maxRounds' | 'stopCondition' | 'maxTokens' | 'cancelled' | 'contextLimit' | 'stopString';
export interface ContextLimit { phase: 'input' | 'generation'; capacityTokens: number; inputTokens: number }
export interface PartialGenerationResult { text: string; newMessages: Message[]; rounds: GenerationRound[] }
export interface GenerationResult<T = unknown, C extends ToolCall = ToolCall> extends PartialGenerationResult {
  stopReason: StopReason;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: C[];
  output?: T;
  contextLimit?: ContextLimit;
}
export interface ToolEvent { call: ToolCall; roundIndex: number }
export interface SamplingOptions {
  temperature?: number; topP?: number; topK?: number; minP?: number;
  repetitionPenalty?: number; presencePenalty?: number; frequencyPenalty?: number; seed?: number;
}
export interface GenerationOptions extends SamplingOptions {
  tools?: ToolMap;
  toolExecution?: 'sequential' | 'parallel';
  maxConcurrentTools?: number;
  toolExecutionTiming?: 'immediate' | 'afterGeneration';
  toolErrorBehavior?: 'continue' | 'stop';
  maxRounds?: number;
  maxTokensPerRound?: number;
  reasoning?: boolean;
  stopStrings?: readonly string[];
  structuredOutput?: { schema: unknown; maxCorrectionAttempts?: number };
  stopWhen?: (context: { readonly messages: readonly Message[]; readonly rounds: readonly GenerationRound[]; readonly latestRound: GenerationRound }) => boolean | PromiseLike<boolean>;
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onRoundStart?: (event: { roundIndex: number }) => void;
  onToolCall?: (event: ToolEvent) => void;
  onToolStart?: (event: ToolEvent) => void;
  onToolResult?: (event: ToolEvent & { output: JsonValue }) => void;
  onToolError?: (event: ToolEvent & { error: Error }) => void;
  onToolCancel?: (event: ToolEvent) => void;
  onToolValidationError?: (event: { request: ToolCall; roundIndex: number; error: { code: 'unknownTool' | 'invalidArguments'; message: string } }) => void;
}

export interface LanguageGeneration<T = unknown, C extends ToolCall = ToolCall> {
  readonly signal: AbortSignal;
  readonly finished: Promise<void>;
  result(): Promise<GenerationResult<T, C>>;
  cancel(): void;
}

export type ToolCallFor<T extends ToolMap> = {
  [K in keyof T & string]: ToolCall<import('../schema/types.js').InferSchema<T[K]['inputSchema']>> & { name: K }
}[keyof T & string];
export type ToolResultEventFor<T extends ToolMap> = {
  [K in keyof T & string]: { call: ToolCall<import('../schema/types.js').InferSchema<T[K]['inputSchema']>> & { name: K }; roundIndex: number; output: T[K] extends { execute?: (...args: any[]) => infer O } ? Awaited<O> : JsonValue }
}[keyof T & string];
export type ToolGenerationOptions<T extends ToolMap> = Omit<GenerationOptions, 'tools' | 'onToolCall' | 'onToolStart' | 'onToolResult' | 'onToolError' | 'onToolCancel'> & {
  tools: T;
  onToolCall?: (event: { call: ToolCallFor<T>; roundIndex: number }) => void;
  onToolStart?: (event: { call: ToolCallFor<T>; roundIndex: number }) => void;
  onToolResult?: (event: ToolResultEventFor<T>) => void;
  onToolError?: (event: { call: ToolCallFor<T>; roundIndex: number; error: Error }) => void;
  onToolCancel?: (event: { call: ToolCallFor<T>; roundIndex: number }) => void;
};

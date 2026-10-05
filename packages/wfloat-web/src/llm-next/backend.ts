import type { ContextLimit, Message, SamplingOptions, ToolCall } from './types';

export interface PreparedSchema {
  jsonSchema: unknown;
  parse(value: unknown): Promise<unknown>;
}
export interface RoundRequest extends SamplingOptions {
  messages: readonly Message[];
  tools?: Record<string, { description?: string; inputSchema: unknown }>;
  structuredOutput?: unknown;
  reasoning?: boolean;
  maxTokensPerRound?: number;
}
export type RoundEvent =
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'done'; stopReason: 'complete' | 'maxTokens' | 'contextLimit'; inputTokens: number; outputTokens: number; contextLimit?: ContextLimit };
export interface LanguageBackend {
  readonly contextSize: number;
  generateRound(request: RoundRequest, signal: AbortSignal): AsyncIterable<RoundEvent>;
  countInputTokens(request: RoundRequest): Promise<number>;
  prepareSchema(schema: unknown): PreparedSchema | Promise<PreparedSchema>;
  unload(): Promise<void>;
}

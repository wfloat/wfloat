/** Internal engine boundary. Public orchestration owns validation and history normalization. */
export interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
export interface NativeTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}
export interface NativeRoundRequest {
  messages: NativeMessage[];
  tools?: NativeTool[];
  jsonSchema?: unknown;
  reasoning?: boolean;
  maxTokensPerRound?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}
export type NativeStopReason = "complete" | "maxTokens" | "contextLimit" | "cancelled";
export type NativeRoundEvent =
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "text" | "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; rawArguments: string }
  | { type: "warning"; message: string }
  | { type: "done"; stopReason: NativeStopReason; inputTokens: number; outputTokens: number; cachedInputTokens: number };
export interface NativeBackend {
  readonly contextSize: number;
  countInputTokens(request: NativeRoundRequest): Promise<number>;
  generateRound(request: NativeRoundRequest, signal?: AbortSignal): AsyncIterable<NativeRoundEvent>;
  checkSchema(schema: unknown): Promise<SchemaValidation>;
  validateSchema(schema: unknown, value: unknown): Promise<SchemaValidation>;
  unload(): Promise<void>;
}
export interface SchemaValidation {
  valid: boolean;
  issues: Array<{ code: string; message: string; instancePath: string; schemaPath: string }>;
}
export interface NativeLoadOptions {
  modelId: string;
  paths: Record<string, string>;
  signal?: AbortSignal;
  contextSize: number;
  numThreads?: number;
  chatTemplate?: string;
}

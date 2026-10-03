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
  model: Blob | ArrayBuffer;
  /** Used only by the loader; never cloned into the worker. */
  signal?: AbortSignal;
  contextSize: number;
  numThreads?: number;
  wasmUrl?: string;
  wasmBinary?: Uint8Array;
  /** Explicit template override; absent means GGUF metadata, with no silent fallback. */
  chatTemplate?: string;
}
export type WorkerCommand =
  | { id: number; type: "load"; options: NativeLoadOptions }
  | { id: number; type: "count" | "generate"; request: NativeRoundRequest }
  | { id: number; type: "abort" }
  | { id: number; type: "schema"; schema: unknown; value?: unknown; validate: boolean }
  | { id: number; type: "unload" };
export type WorkerReply =
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "event"; event: NativeRoundEvent }
  | { id: number; type: "error"; message: string };

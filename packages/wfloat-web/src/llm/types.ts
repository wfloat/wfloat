import type { LoadModelProgressEvent } from "../tts/types.js";

export type LlmChatMessage = {
  role: string;
  content: string;
};

export type LlmGenerationResult = {
  text: string;
  modelId: string;
  finishReason: string;
  promptTokenCount: number;
  completionTokenCount: number;
  json?: string;
};

export type LlmTokenEvent = {
  text: string;
  tokenIndex: number;
  tokenId: number;
  isDone: boolean;
};

export type LlmGenerationOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  seed?: number;
  onToken?: (event: LlmTokenEvent) => void;
};

export type LlmChatTemplateFormat = "gguf" | "chatml";

export type LoadLlmModelOptions = {
  modelAssetHost?: string;
  contextSize?: number;
  numThreads?: number;
  onProgress?: (event: LoadModelProgressEvent) => void;
};

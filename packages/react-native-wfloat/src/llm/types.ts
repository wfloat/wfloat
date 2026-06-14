import type { LoadModelProgressEvent } from '../tts/types';

export type LlmChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type LlmChatMessage = {
  role: LlmChatRole | string;
  content: string;
};

export type LlmTokenEvent = {
  text: string;
  tokenIndex: number;
  tokenId: number;
  isDone: boolean;
};

export type LlmGenerationResult = {
  text: string;
  modelId: string;
  finishReason: string;
  promptTokenCount: number;
  completionTokenCount: number;
  json: string;
};

export type LlmGenerationOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  seed?: number;
  onToken?: (event: LlmTokenEvent) => void | Promise<void>;
};

export type LlmGenerateOptions = LlmGenerationOptions & {
  prompt: string;
};

export type LlmChatOptions = LlmGenerationOptions & {
  messages: LlmChatMessage[];
  addGenerationPrompt?: boolean;
};

export type LoadLlmModelOptions = {
  onProgress?: (event: LoadModelProgressEvent) => void;
  contextSize?: number;
  numThreads?: number;
  gpuLayerCount?: number;
};

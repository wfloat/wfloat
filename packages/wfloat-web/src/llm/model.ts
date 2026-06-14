import { LlmWorkerBridge } from "../worker/llmWorkerBridge.js";
import type {
  LlmChatMessage,
  LlmChatTemplateFormat,
  LlmGenerationOptions,
  LlmGenerationResult,
  LoadLlmModelOptions,
} from "./types.js";

export class LlmModel {
  private constructor(
    public readonly modelId: string,
    public readonly family: string,
    public readonly contextSize: number,
    public readonly chatTemplateFormat: LlmChatTemplateFormat,
  ) {}

  static async load(modelId: string, options: LoadLlmModelOptions = {}): Promise<LlmModel> {
    const response = await LlmWorkerBridge.loadModel(modelId, options);

    options.onProgress?.({ status: "completed" });

    return new LlmModel(
      modelId,
      response.family,
      response.contextSize,
      response.chatTemplateFormat,
    );
  }

  async generate(prompt: string, options: LlmGenerationOptions = {}): Promise<LlmGenerationResult> {
    const { onToken, ...workerOptions } = options;
    return LlmWorkerBridge.generate({
      prompt,
      ...workerOptions,
    }, onToken);
  }

  async chat(
    messages: LlmChatMessage[],
    options: LlmGenerationOptions = {},
  ): Promise<LlmGenerationResult> {
    const { onToken, ...workerOptions } = options;
    return LlmWorkerBridge.chat({
      messages,
      ...workerOptions,
    }, onToken);
  }
}

export async function loadLlmModel(
  modelId: string,
  options: LoadLlmModelOptions = {},
): Promise<LlmModel> {
  return LlmModel.load(modelId, options);
}

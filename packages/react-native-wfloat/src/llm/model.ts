import Wfloat, {
  type NativeLlmGenerationResult,
  type NativeLlmTokenEvent,
  type NativeLoadModelProgressEvent,
} from '../NativeWfloat';
import { getLlmModelAssets } from '../modelAssets';
import type {
  LlmChatMessage,
  LlmChatOptions,
  LlmGenerateOptions,
  LlmGenerationOptions,
  LlmGenerationResult,
  LlmTokenEvent,
  LoadLlmModelOptions,
} from './types';

const DEFAULT_CONTEXT_SIZE = 2048;
const DEFAULT_NUM_THREADS = 4;
const DEFAULT_GPU_LAYER_COUNT = 0;
const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_TOP_K = 40;
const DEFAULT_REPEAT_PENALTY = 1;
const DEFAULT_SEED = 0;

let nextRequestId = 1;

function normalizeLoadProgressEvent(
  event: NativeLoadModelProgressEvent
): import('../tts/types').LoadModelProgressEvent | null {
  if (event.status === 'downloading') {
    return {
      status: 'downloading',
      progress:
        typeof event.progress === 'number' && Number.isFinite(event.progress)
          ? Math.min(Math.max(event.progress, 0), 1)
          : 0,
    };
  }

  if (event.status === 'loading') {
    return { status: 'loading' };
  }

  if (event.status === 'completed') {
    return { status: 'completed' };
  }

  console.warn(
    `Ignoring unknown loadModel progress event status "${event.status}".`
  );
  return null;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeGenerationOptions(options: LlmGenerationOptions) {
  return {
    maxTokens: normalizePositiveInt(options.maxTokens, DEFAULT_MAX_TOKENS),
    temperature: normalizeFiniteNumber(
      options.temperature,
      DEFAULT_TEMPERATURE
    ),
    topP: normalizeFiniteNumber(options.topP, DEFAULT_TOP_P),
    topK: normalizePositiveInt(options.topK, DEFAULT_TOP_K),
    repeatPenalty: normalizeFiniteNumber(
      options.repeatPenalty,
      DEFAULT_REPEAT_PENALTY
    ),
    seed:
      typeof options.seed === 'number' && Number.isFinite(options.seed)
        ? Math.trunc(options.seed)
        : DEFAULT_SEED,
  };
}

function mapTokenEvent(event: NativeLlmTokenEvent): LlmTokenEvent {
  return {
    text: typeof event.text === 'string' ? event.text : '',
    tokenIndex:
      typeof event.tokenIndex === 'number' && Number.isFinite(event.tokenIndex)
        ? Math.max(0, Math.trunc(event.tokenIndex))
        : 0,
    tokenId:
      typeof event.tokenId === 'number' && Number.isFinite(event.tokenId)
        ? Math.trunc(event.tokenId)
        : 0,
    isDone: Boolean(event.isDone),
  };
}

function mapGenerationResult(
  result: NativeLlmGenerationResult
): LlmGenerationResult {
  return {
    text: typeof result.text === 'string' ? result.text : '',
    modelId: typeof result.modelId === 'string' ? result.modelId : '',
    finishReason:
      typeof result.finishReason === 'string' ? result.finishReason : '',
    promptTokenCount:
      typeof result.promptTokenCount === 'number' &&
      Number.isFinite(result.promptTokenCount)
        ? Math.max(0, Math.trunc(result.promptTokenCount))
        : 0,
    completionTokenCount:
      typeof result.completionTokenCount === 'number' &&
      Number.isFinite(result.completionTokenCount)
        ? Math.max(0, Math.trunc(result.completionTokenCount))
        : 0,
    json: typeof result.json === 'string' ? result.json : '',
  };
}

function normalizeMessages(messages: LlmChatMessage[]): LlmChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must contain at least one chat message.');
  }

  return messages.map((message, index) => {
    const role = typeof message.role === 'string' ? message.role.trim() : '';
    const content =
      typeof message.content === 'string'
        ? message.content
        : String(message.content);

    if (!role) {
      throw new Error(`messages[${index}].role is required.`);
    }

    return { role, content };
  });
}

export class LlmModel {
  private constructor(
    public readonly modelId: string,
    public readonly family: string,
    public readonly contextSize: number
  ) {}

  static async load(
    modelId: string,
    options: LoadLlmModelOptions = {}
  ): Promise<LlmModel> {
    const assets = await getLlmModelAssets(modelId, options.modelAssetHost);
    const progressSubscription = Wfloat.onLoadModelProgress(
      (event: NativeLoadModelProgressEvent) => {
        const normalized = normalizeLoadProgressEvent(event);
        if (normalized) {
          options.onProgress?.(normalized);
        }
      }
    );

    const chatTemplate =
      assets.chatTemplate ??
      (assets.chatTemplateFormat === 'chatml' ? 'chatml' : '');

    try {
      const nativeResult = await Wfloat.loadLlmModel({
        modelId,
        family: assets.family,
        modelUrl: assets.model,
        contextSize: normalizePositiveInt(
          options.contextSize,
          assets.contextSize ?? DEFAULT_CONTEXT_SIZE
        ),
        numThreads: normalizePositiveInt(
          options.numThreads,
          DEFAULT_NUM_THREADS
        ),
        gpuLayerCount:
          typeof options.gpuLayerCount === 'number' &&
          Number.isFinite(options.gpuLayerCount)
            ? Math.max(0, Math.trunc(options.gpuLayerCount))
            : DEFAULT_GPU_LAYER_COUNT,
        chatTemplate,
      });

      options.onProgress?.({ status: 'completed' });
      return new LlmModel(
        modelId,
        nativeResult.family,
        normalizePositiveInt(nativeResult.contextSize, DEFAULT_CONTEXT_SIZE)
      );
    } finally {
      progressSubscription.remove();
    }
  }

  async generate(options: LlmGenerateOptions): Promise<LlmGenerationResult> {
    const prompt = typeof options.prompt === 'string' ? options.prompt : '';
    if (!prompt.trim()) {
      throw new Error('prompt is required.');
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const generationOptions = normalizeGenerationOptions(options);

    return this.withTokenSubscription(requestId, options.onToken, async () => {
      return mapGenerationResult(
        await Wfloat.generateLlm({
          requestId,
          prompt,
          ...generationOptions,
        })
      );
    });
  }

  async chat(options: LlmChatOptions): Promise<LlmGenerationResult> {
    const requestId = nextRequestId;
    nextRequestId += 1;
    const generationOptions = normalizeGenerationOptions(options);
    const messages = normalizeMessages(options.messages);

    return this.withTokenSubscription(requestId, options.onToken, async () => {
      return mapGenerationResult(
        await Wfloat.chatLlm({
          requestId,
          messages,
          addGenerationPrompt: options.addGenerationPrompt !== false,
          ...generationOptions,
        })
      );
    });
  }

  private async withTokenSubscription<T>(
    requestId: number,
    onToken: LlmGenerationOptions['onToken'],
    run: () => Promise<T>
  ): Promise<T> {
    const subscription = onToken
      ? Wfloat.onLlmToken((event) => {
          if (event.requestId === requestId) {
            Promise.resolve(onToken(mapTokenEvent(event))).catch(
              (error: unknown) => {
                console.warn(
                  error instanceof Error
                    ? error.message
                    : 'LLM token callback failed.'
                );
              }
            );
          }
        })
      : null;

    try {
      return await run();
    } finally {
      subscription?.remove();
    }
  }
}

export async function loadLlmModel(
  modelId: string,
  options: LoadLlmModelOptions = {}
): Promise<LlmModel> {
  return LlmModel.load(modelId, options);
}

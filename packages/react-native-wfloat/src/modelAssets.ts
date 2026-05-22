import {
  fetchLlmModelManifest,
  fetchSttModelManifest,
  fetchTtsModelManifest,
  fetchVadModelManifest,
} from './modelManifest';

export type ModelAssetsResponse = {
  model_onnx: string;
  model_tokens: string;
  espeak_data: string;
  espeak_checksum: string;
};

export type SttModelAssetsResponse = {
  family: string;
  model?: string;
  tokens?: string;
  preprocessor?: string;
  encoder?: string;
  decoder?: string;
  joiner?: string;
  uncached_decoder?: string;
  cached_decoder?: string;
};

export type VadModelAssetsResponse = {
  family: string;
  model: string;
};

export type LlmModelAssetsResponse = {
  family: string;
  model: string;
  contextSize?: number;
  chatTemplate?: string;
  chatTemplateFormat?: 'gguf' | 'chatml';
};

export async function getModelAssets(
  modelId: string,
  modelAssetHost?: string
): Promise<ModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const data = await fetchTtsModelManifest({
    modelName: trimmedModelId,
    host: modelAssetHost,
  });
  const files =
    data.files && typeof data.files === 'object' ? data.files : undefined;

  if (!files?.model?.url || !files?.tokens?.url || !files?.espeak_data?.url) {
    throw new Error('Model asset manifest is missing required URLs.');
  }

  return {
    model_onnx: files.model.url,
    model_tokens: files.tokens.url,
    espeak_data: files.espeak_data.url,
    espeak_checksum:
      typeof files.espeak_data.checksum === 'string'
        ? files.espeak_data.checksum
        : '',
  };
}

export async function getSttModelAssets(
  modelId: string,
  modelAssetHost?: string
): Promise<SttModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const data = await fetchSttModelManifest({
    modelName: trimmedModelId,
    host: modelAssetHost,
  });
  const files =
    data.files && typeof data.files === 'object' ? data.files : undefined;
  const family = typeof data.family === 'string' ? data.family : '';

  if (!family || !files?.tokens?.url) {
    throw new Error('STT model asset manifest is missing required fields.');
  }

  return {
    family,
    model: files.model?.url,
    tokens: files.tokens?.url,
    preprocessor: files.preprocessor?.url,
    encoder: files.encoder?.url,
    decoder: files.decoder?.url,
    joiner: files.joiner?.url,
    uncached_decoder: files.uncached_decoder?.url,
    cached_decoder: files.cached_decoder?.url,
  };
}

export async function getVadModelAssets(
  modelId: string,
  modelAssetHost?: string
): Promise<VadModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const data = await fetchVadModelManifest({
    modelName: trimmedModelId,
    host: modelAssetHost,
  });
  const files =
    data.files && typeof data.files === 'object' ? data.files : undefined;
  const family = typeof data.family === 'string' ? data.family : '';

  if (!family || !files?.model?.url) {
    throw new Error('VAD model asset manifest is missing required fields.');
  }

  return {
    family,
    model: files.model.url,
  };
}

export async function getLlmModelAssets(
  modelId: string,
  modelAssetHost?: string
): Promise<LlmModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const data = await fetchLlmModelManifest({
    modelName: trimmedModelId,
    host: modelAssetHost,
  });
  const files =
    data.files && typeof data.files === 'object' ? data.files : undefined;
  const family = typeof data.family === 'string' ? data.family : '';

  if (!family || !files?.model?.url) {
    throw new Error('LLM model asset manifest is missing required fields.');
  }

  const contextSize =
    typeof data.context_size === 'number' && Number.isFinite(data.context_size)
      ? Math.max(1, Math.trunc(data.context_size))
      : undefined;

  return {
    family,
    model: files.model.url,
    contextSize,
    chatTemplate:
      typeof data.chat_template === 'string' && data.chat_template.trim()
        ? data.chat_template
        : undefined,
    chatTemplateFormat: data.chat_template_format,
  };
}

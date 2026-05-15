import { fetchTtsModelManifest } from './modelManifest';

export type ModelAssetsResponse = {
  model_onnx: string;
  model_tokens: string;
  espeak_data: string;
  espeak_checksum: string;
};

export async function getModelAssets(
  modelId: string
): Promise<ModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const data = await fetchTtsModelManifest({
    modelName: trimmedModelId,
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

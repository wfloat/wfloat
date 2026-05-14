import { Platform } from 'react-native';

export type ModelAssetsResponse = {
  model_onnx: string;
  model_tokens: string;
  espeak_data: string;
  espeak_checksum: string;
};

const MODEL_ASSET_HOST = 'https://wfloat.com';
const WFLOAT_REACT_NATIVE_VERSION = '1.0.2';

function getModelAssetPlatform(): string {
  switch (Platform.OS) {
    case 'ios':
      return 'react-native-ios';
    case 'android':
      return 'react-native-android';
    default:
      throw new Error(`Unsupported platform for model assets: ${Platform.OS}`);
  }
}

export async function getModelAssets(
  modelId: string
): Promise<ModelAssetsResponse> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  const params = new URLSearchParams({
    model_id: trimmedModelId,
    platform: getModelAssetPlatform(),
    version: WFLOAT_REACT_NATIVE_VERSION,
  });

  const response = await fetch(
    `${MODEL_ASSET_HOST}/api/model-assets?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    console.log(response);
    throw new Error(`Request failed: ${response.status}`);
  }

  const data = (await response.json()) as Partial<ModelAssetsResponse>;
  if (
    !data.model_onnx ||
    !data.model_tokens ||
    !data.espeak_data ||
    !data.espeak_checksum
  ) {
    throw new Error('Model asset response is missing required URLs.');
  }

  return {
    model_onnx: data.model_onnx,
    model_tokens: data.model_tokens,
    espeak_data: data.espeak_data,
    espeak_checksum: data.espeak_checksum,
  };
}

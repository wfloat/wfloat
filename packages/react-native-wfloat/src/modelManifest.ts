import { Platform } from 'react-native';

export type ModelManifestFile = {
  url?: string;
  checksum?: string | null;
};

export type ModelManifestDistribution = {
  provider?: string;
  base_url?: string;
  repository?: string;
};

export type BaseModelManifest = {
  capability?: string;
  platform?: string;
  model_name?: string;
  family?: string;
  distribution?: ModelManifestDistribution;
  persistent_id?: string;
};

export type TtsModelManifest = BaseModelManifest & {
  files?: {
    model?: ModelManifestFile;
    tokens?: ModelManifestFile;
    espeak_data?: ModelManifestFile;
  };
};

export type SttModelManifest = BaseModelManifest & {
  files?: {
    model?: ModelManifestFile;
    tokens?: ModelManifestFile;
    preprocessor?: ModelManifestFile;
    encoder?: ModelManifestFile;
    decoder?: ModelManifestFile;
    joiner?: ModelManifestFile;
    uncached_decoder?: ModelManifestFile;
    cached_decoder?: ModelManifestFile;
  };
};

export type VadModelManifest = BaseModelManifest & {
  files?: {
    model?: ModelManifestFile;
  };
};

export type LlmModelManifest = BaseModelManifest & {
  context_size?: number;
  chat_template?: string;
  chat_template_format?: 'gguf' | 'chatml';
  files?: {
    model?: ModelManifestFile;
  };
};

const MODEL_ASSET_HOST = 'https://wfloat.com';
const MODEL_ASSET_PATH = '/api/model-assets';
const WFLOAT_REACT_NATIVE_VERSION = '1.0.2';

export function getModelManifestPlatform(): string {
  switch (Platform.OS) {
    case 'ios':
      return 'react-native-ios';
    case 'android':
      return 'react-native-android';
    default:
      throw new Error(`Unsupported platform for model assets: ${Platform.OS}`);
  }
}

export async function fetchModelManifest(args: {
  modelName: string;
  platform?: string;
  version?: string;
  persistentId?: string;
  host?: string;
}): Promise<BaseModelManifest> {
  const params = new URLSearchParams({
    model_name: args.modelName,
    platform: args.platform ?? getModelManifestPlatform(),
    version: args.version ?? WFLOAT_REACT_NATIVE_VERSION,
  });

  if (args.persistentId) {
    params.set('persistent_id', args.persistentId);
  }

  const response = await fetch(
    `${args.host ?? MODEL_ASSET_HOST}${MODEL_ASSET_PATH}?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as BaseModelManifest;
}

export async function fetchTtsModelManifest(args: {
  modelName: string;
  platform?: string;
  version?: string;
  persistentId?: string;
  host?: string;
}): Promise<TtsModelManifest> {
  return (await fetchModelManifest(args)) as TtsModelManifest;
}

export async function fetchSttModelManifest(args: {
  modelName: string;
  platform?: string;
  version?: string;
  persistentId?: string;
  host?: string;
}): Promise<SttModelManifest> {
  return (await fetchModelManifest(args)) as SttModelManifest;
}

export async function fetchVadModelManifest(args: {
  modelName: string;
  platform?: string;
  version?: string;
  persistentId?: string;
  host?: string;
}): Promise<VadModelManifest> {
  return (await fetchModelManifest(args)) as VadModelManifest;
}

export async function fetchLlmModelManifest(args: {
  modelName: string;
  platform?: string;
  version?: string;
  persistentId?: string;
  host?: string;
}): Promise<LlmModelManifest> {
  return (await fetchModelManifest(args)) as LlmModelManifest;
}

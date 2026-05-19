export type ModelManifestFile = {
  url?: string;
  checksum?: string | null;
};

export type ModelManifestDistribution = {
  provider?: string;
  base_url?: string;
  repository?: string;
};

export type ModelManifestRuntime = {
  version?: string;
  wasm_binary?: ModelManifestFile;
  wasm_data?: ModelManifestFile;
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
  runtime?: ModelManifestRuntime;
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
  runtime?: ModelManifestRuntime;
};

export type VadModelManifest = BaseModelManifest & {
  files?: {
    model?: ModelManifestFile;
  };
  runtime?: ModelManifestRuntime;
};

const DEFAULT_MODEL_ASSET_HOST = "https://wfloat.com";
const MODEL_ASSET_PATH = "/api/model-assets";

function resolveModelAssetHost(overrideHost?: string): string {
  const normalized = overrideHost?.trim();
  return normalized && normalized.length > 0 ? normalized.replace(/\/+$/, "") : DEFAULT_MODEL_ASSET_HOST;
}

export async function fetchModelManifest(args: {
  modelName: string;
  platform: string;
  version: string;
  sherpaOnnxVersion?: string;
  persistentId?: string;
  modelAssetHost?: string;
}): Promise<BaseModelManifest> {
  const params = new URLSearchParams();
  params.set("model_name", args.modelName);
  params.set("platform", args.platform);
  params.set("version", args.version);
  if (args.sherpaOnnxVersion) {
    params.set("sherpa_onnx_version", args.sherpaOnnxVersion);
  }
  if (args.persistentId) {
    params.set("persistent_id", args.persistentId);
  }

  const response = await fetch(
    `${resolveModelAssetHost(args.modelAssetHost)}${MODEL_ASSET_PATH}?${params.toString()}`,
    {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    },
  );

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as BaseModelManifest;
}

export async function fetchTtsModelManifest(args: {
  modelName: string;
  platform: string;
  version: string;
  sherpaOnnxVersion?: string;
  persistentId?: string;
  modelAssetHost?: string;
}): Promise<TtsModelManifest> {
  return (await fetchModelManifest(args)) as TtsModelManifest;
}

export async function fetchSttModelManifest(args: {
  modelName: string;
  platform: string;
  version: string;
  sherpaOnnxVersion?: string;
  persistentId?: string;
  modelAssetHost?: string;
}): Promise<SttModelManifest> {
  return (await fetchModelManifest(args)) as SttModelManifest;
}

export async function fetchVadModelManifest(args: {
  modelName: string;
  platform: string;
  version: string;
  sherpaOnnxVersion?: string;
  persistentId?: string;
  modelAssetHost?: string;
}): Promise<VadModelManifest> {
  return (await fetchModelManifest(args)) as VadModelManifest;
}

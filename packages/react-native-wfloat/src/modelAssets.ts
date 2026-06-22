import { Platform } from 'react-native';

import { MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS } from './generatedModelUrls';

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

const WFLOAT_TTS_MODEL_ID = 'wfloat/wfloat-tts';
const SILERO_VAD_MODEL_ID = 'snakers4/silero-vad';
const SMOLLM2_360M_INSTRUCT_MODEL_ID = 'HuggingFaceTB/SmolLM2-360M-Instruct';

type RegistryFile = {
  readonly path: string;
  readonly sha256: string | null;
};

function registryUrl(asset: RegistryFile): string {
  return `${REGISTRY_ORIGIN}${asset.path}`;
}

const WFLOAT_TTS_ASSETS = MODEL_ASSETS[WFLOAT_TTS_MODEL_ID];
const WHISPER_TINY_EN_ASSETS = MODEL_ASSETS['openai/whisper-tiny-en'];
const STREAMING_ZIPFORMER_EN_ASSETS = MODEL_ASSETS['k2-fsa/streaming-zipformer-en'];
const MOONSHINE_TINY_ASSETS = MODEL_ASSETS['UsefulSensors/moonshine-tiny'];
const SILERO_VAD_ASSETS = MODEL_ASSETS[SILERO_VAD_MODEL_ID];
const SMOLLM2_360M_INSTRUCT_ASSETS = MODEL_ASSETS[SMOLLM2_360M_INSTRUCT_MODEL_ID];

const TTS_MODEL = {
  model_onnx: registryUrl(WFLOAT_TTS_ASSETS.model_onnx),
  model_tokens: registryUrl(WFLOAT_TTS_ASSETS.model_tokens),
  android_espeak_data: registryUrl(SHARED_ASSETS.espeak_ng_data_zip),
  android_espeak_checksum: SHARED_ASSETS.espeak_ng_data_zip.sha256,
  ios_espeak_data: registryUrl(SHARED_ASSETS.espeak_ng_data_aar),
  ios_espeak_checksum: SHARED_ASSETS.espeak_ng_data_aar.sha256,
};

const STT_MODELS: Record<string, SttModelAssetsResponse> = {
  'openai/whisper-tiny-en': {
    family: WHISPER_TINY_EN_ASSETS.family,
    encoder: registryUrl(WHISPER_TINY_EN_ASSETS.encoder),
    decoder: registryUrl(WHISPER_TINY_EN_ASSETS.decoder),
    tokens: registryUrl(WHISPER_TINY_EN_ASSETS.tokens),
  },
  'k2-fsa/streaming-zipformer-en': {
    family: STREAMING_ZIPFORMER_EN_ASSETS.family,
    encoder: registryUrl(STREAMING_ZIPFORMER_EN_ASSETS.encoder),
    decoder: registryUrl(STREAMING_ZIPFORMER_EN_ASSETS.decoder),
    joiner: registryUrl(STREAMING_ZIPFORMER_EN_ASSETS.joiner),
    tokens: registryUrl(STREAMING_ZIPFORMER_EN_ASSETS.tokens),
  },
  'UsefulSensors/moonshine-tiny': {
    family: MOONSHINE_TINY_ASSETS.family,
    preprocessor: registryUrl(MOONSHINE_TINY_ASSETS.preprocessor),
    encoder: registryUrl(MOONSHINE_TINY_ASSETS.encoder),
    uncached_decoder: registryUrl(MOONSHINE_TINY_ASSETS.uncached_decoder),
    cached_decoder: registryUrl(MOONSHINE_TINY_ASSETS.cached_decoder),
    tokens: registryUrl(MOONSHINE_TINY_ASSETS.tokens),
  },
};

const VAD_MODELS: Record<string, VadModelAssetsResponse> = {
  [SILERO_VAD_MODEL_ID]: {
    family: SILERO_VAD_ASSETS.family,
    model: registryUrl(SILERO_VAD_ASSETS.model),
  },
};

const LLM_MODELS: Record<string, LlmModelAssetsResponse> = {
  [SMOLLM2_360M_INSTRUCT_MODEL_ID]: {
    family: SMOLLM2_360M_INSTRUCT_ASSETS.family,
    model: registryUrl(SMOLLM2_360M_INSTRUCT_ASSETS.model),
    contextSize: Platform.OS === 'android' ? 4096 : 8192,
    chatTemplateFormat: 'chatml',
  },
};

function requireModelId(modelId: string): string {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    throw new Error('modelId is required.');
  }

  return trimmedModelId;
}

export async function getModelAssets(modelId: string): Promise<ModelAssetsResponse> {
  const trimmedModelId = requireModelId(modelId);
  if (trimmedModelId !== WFLOAT_TTS_MODEL_ID) {
    throw new Error(`Unsupported TTS model: ${trimmedModelId}`);
  }

  return {
    model_onnx: TTS_MODEL.model_onnx,
    model_tokens: TTS_MODEL.model_tokens,
    espeak_data:
      Platform.OS === 'ios' ? TTS_MODEL.ios_espeak_data : TTS_MODEL.android_espeak_data,
    espeak_checksum:
      Platform.OS === 'ios'
        ? TTS_MODEL.ios_espeak_checksum
        : TTS_MODEL.android_espeak_checksum,
  };
}

export async function getSttModelAssets(modelId: string): Promise<SttModelAssetsResponse> {
  const trimmedModelId = requireModelId(modelId);
  const model = STT_MODELS[trimmedModelId];
  if (!model) {
    throw new Error(`Unsupported STT model: ${trimmedModelId}`);
  }

  return model;
}

export async function getVadModelAssets(modelId: string): Promise<VadModelAssetsResponse> {
  const trimmedModelId = requireModelId(modelId);
  const model = VAD_MODELS[trimmedModelId];
  if (!model) {
    throw new Error(`Unsupported VAD model: ${trimmedModelId}`);
  }

  return model;
}

export async function getLlmModelAssets(modelId: string): Promise<LlmModelAssetsResponse> {
  const trimmedModelId = requireModelId(modelId);
  const model = LLM_MODELS[trimmedModelId];
  if (!model) {
    throw new Error(`Unsupported LLM model: ${trimmedModelId}`);
  }

  return model;
}

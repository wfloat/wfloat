import { Platform } from 'react-native';

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

const REGISTRY_BASE_URL = 'https://registry.wfloat.com';
const WFLOAT_TTS_MODEL_ID = 'wfloat/wfloat-tts';
const SILERO_VAD_MODEL_ID = 'snakers4/silero-vad';
const SMOLLM2_360M_INSTRUCT_MODEL_ID = 'HuggingFaceTB/SmolLM2-360M-Instruct';

const TTS_MODEL = {
  model_onnx: `${REGISTRY_BASE_URL}/models/wfloat-model/1.0.2/wfloat-model-1.0.2.onnx`,
  model_tokens: `${REGISTRY_BASE_URL}/models/wfloat-model/1.0.2/wfloat-model-1.0.2_tokens.txt`,
  android_espeak_data: `${REGISTRY_BASE_URL}/espeak-ng-data/espeak-ng-data-2023.9.7-4.zip`,
  android_espeak_checksum:
    '56c2879ab1ab44c594c78f34e76c50cf1dd7b8f6ca0ca2634b6766a6edb32add',
  ios_espeak_data: `${REGISTRY_BASE_URL}/espeak-ng-data/espeak-ng-data-2023.9.7-4.aar`,
  ios_espeak_checksum:
    'a526b72e81cb1a17e07f55ca0117bba8fbcac7ccd2fa502c61be926eafeaf64e',
};

const STT_MODELS: Record<string, SttModelAssetsResponse> = {
  'openai/whisper-tiny-en': {
    family: 'whisper',
    encoder: `${REGISTRY_BASE_URL}/models/openai/whisper-tiny-en/tiny.en-encoder.int8.onnx`,
    decoder: `${REGISTRY_BASE_URL}/models/openai/whisper-tiny-en/tiny.en-decoder.int8.onnx`,
    tokens: `${REGISTRY_BASE_URL}/models/openai/whisper-tiny-en/tiny.en-tokens.txt`,
  },
  'k2-fsa/streaming-zipformer-en': {
    family: 'zipformer-transducer',
    encoder: `${REGISTRY_BASE_URL}/models/k2-fsa/streaming-zipformer-en/encoder-epoch-99-avg-1.int8.onnx`,
    decoder: `${REGISTRY_BASE_URL}/models/k2-fsa/streaming-zipformer-en/decoder-epoch-99-avg-1.onnx`,
    joiner: `${REGISTRY_BASE_URL}/models/k2-fsa/streaming-zipformer-en/joiner-epoch-99-avg-1.onnx`,
    tokens: `${REGISTRY_BASE_URL}/models/k2-fsa/streaming-zipformer-en/tokens.txt`,
  },
  'UsefulSensors/moonshine-tiny': {
    family: 'moonshine',
    preprocessor: `${REGISTRY_BASE_URL}/models/usefulsensors-moonshine-tiny/preprocessor.onnx`,
    encoder: `${REGISTRY_BASE_URL}/models/usefulsensors-moonshine-tiny/encoder.int8.onnx`,
    uncached_decoder: `${REGISTRY_BASE_URL}/models/usefulsensors-moonshine-tiny/uncached_decoder.int8.onnx`,
    cached_decoder: `${REGISTRY_BASE_URL}/models/usefulsensors-moonshine-tiny/cached_decoder.int8.onnx`,
    tokens: `${REGISTRY_BASE_URL}/models/usefulsensors-moonshine-tiny/tokens.txt`,
  },
};

const VAD_MODELS: Record<string, VadModelAssetsResponse> = {
  [SILERO_VAD_MODEL_ID]: {
    family: 'silero-vad',
    model: `${REGISTRY_BASE_URL}/models/snakers4/silero-vad/silero_vad.onnx`,
  },
};

const LLM_MODELS: Record<string, LlmModelAssetsResponse> = {
  [SMOLLM2_360M_INSTRUCT_MODEL_ID]: {
    family: 'smollm',
    model: `${REGISTRY_BASE_URL}/models/huggingface/smollm2-360m-instruct/SmolLM2-360M-Instruct.Q4_K_M.gguf`,
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

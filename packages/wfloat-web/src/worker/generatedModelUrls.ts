// Generated from wfloat/assets/registry.json. Do not edit.

export const REGISTRY_ORIGIN = "https://registry.wfloat.com";

export const MODEL_ASSETS = {
  "HuggingFaceTB/SmolLM2-360M-Instruct": {
    "family": "smollm",
    "model": {
      "path": "/models/huggingfacetb/smollm2-360m-instruct/model.Q4_K_M.gguf",
      "sha256": "75c4346ef9e855ed630f80078a2430cf63aaca599e340360998a313070fcdc47"
    }
  },
  "UsefulSensors/moonshine-tiny": {
    "cached_decoder": {
      "path": "/models/usefulsensors/moonshine-tiny/cached_decoder.int8.onnx",
      "sha256": "2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6"
    },
    "encoder": {
      "path": "/models/usefulsensors/moonshine-tiny/encoder.int8.onnx",
      "sha256": "8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb"
    },
    "family": "moonshine",
    "preprocessor": {
      "path": "/models/usefulsensors/moonshine-tiny/preprocessor.onnx",
      "sha256": "f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e"
    },
    "tokens": {
      "path": "/models/usefulsensors/moonshine-tiny/tokens.txt",
      "sha256": "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea"
    },
    "uncached_decoder": {
      "path": "/models/usefulsensors/moonshine-tiny/uncached_decoder.int8.onnx",
      "sha256": "216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41"
    }
  },
  "k2-fsa/streaming-zipformer-en": {
    "decoder": {
      "path": "/models/k2-fsa/streaming-zipformer-en/decoder.onnx",
      "sha256": "9da02b77cb08826756ec6a88635f35a40374e4164e7c6359121a9145958a6ceb"
    },
    "encoder": {
      "path": "/models/k2-fsa/streaming-zipformer-en/encoder.int8.onnx",
      "sha256": "32c98281c7bd8b63e3e142d007251b37f120572e8fdea9a4f5a79ce22b10ec4f"
    },
    "family": "zipformer-transducer",
    "joiner": {
      "path": "/models/k2-fsa/streaming-zipformer-en/joiner.onnx",
      "sha256": "bd5c26ad6a41cbd90c2cfa239c0b55b145af878ce1d79b4739d90f8be93359ba"
    },
    "tokens": {
      "path": "/models/k2-fsa/streaming-zipformer-en/tokens.txt",
      "sha256": "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb"
    }
  },
  "openai/whisper-tiny-en": {
    "decoder": {
      "path": "/models/openai/whisper-tiny-en/decoder.int8.onnx",
      "sha256": "06c0e6ff6348d427e51839219d1c886c18cfdf411e629e33f5e1679bff9c1527"
    },
    "encoder": {
      "path": "/models/openai/whisper-tiny-en/encoder.int8.onnx",
      "sha256": "0ce578b827c94a961aacb8fa14b02f096504b337e5c94be37c36238cbe3e8bc6"
    },
    "family": "whisper",
    "tokens": {
      "path": "/models/openai/whisper-tiny-en/tokens.txt",
      "sha256": "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930"
    }
  },
  "snakers4/silero-vad": {
    "family": "silero-vad",
    "model": {
      "path": "/models/snakers4/silero-vad/model.onnx",
      "sha256": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
    }
  },
  "wfloat/wfloat-tts": {
    "model_onnx": {
      "path": "/models/wfloat/wfloat-tts/model.onnx",
      "sha256": "a7e65773a29499b80a393bbe08af3507e18f6ef95faa0eaf7cb4ba353c8693ae"
    },
    "model_tokens": {
      "path": "/models/wfloat/wfloat-tts/tokens.txt",
      "sha256": "96fd291bede0544469d4d8935d462fdd6dc947f22ad47369753e1a82db3d748e"
    }
  }
} as const;

export const SHARED_ASSETS = {
  "espeak_ng_data_aar": {
    "path": "/assets/espeak-ng-data/espeak-ng-data-2023.9.7-4.aar",
    "sha256": "a526b72e81cb1a17e07f55ca0117bba8fbcac7ccd2fa502c61be926eafeaf64e"
  },
  "espeak_ng_data_zip": {
    "path": "/assets/espeak-ng-data/espeak-ng-data-2023.9.7-4.zip",
    "sha256": "56c2879ab1ab44c594c78f34e76c50cf1dd7b8f6ca0ca2634b6766a6edb32add"
  }
} as const;

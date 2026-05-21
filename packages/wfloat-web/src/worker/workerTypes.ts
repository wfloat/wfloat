import type { TranscriptionResult } from "../stt/types.js";
import type { LoadModelProgressEvent, TtsEmotion } from "../tts/types.js";
import type { VadDetectionResult, VadSegment, VadSpeechStartEvent } from "../vad/types.js";

export type WorkerRequestTemplate =
  | { type: "speech-load-model"; modelId: string; persistentId?: string; modelAssetHost?: string }
  | { type: "speech-generate"; options: SpeechGenerateWorkerOptions }
  | { type: "speech-generate-dialogue"; options: SpeechGenerateDialogueWorkerOptions }
  | { type: "speech-terminate-early" }
  | {
      type: "stt-load-model";
      modelId: string;
      persistentId?: string;
      modelAssetHost?: string;
      language?: string;
      task?: "transcribe" | "translate";
    }
  | {
      type: "stt-transcribe";
      samples: Float32Array;
      sampleRate: number;
    }
  | {
      type: "stt-create-session";
    }
  | {
      type: "stt-session-push";
      sessionId: number;
      samples: Float32Array;
      sampleRate: number;
    }
  | {
      type: "stt-session-get-result";
      sessionId: number;
    }
  | {
      type: "stt-session-finish";
      sessionId: number;
    }
  | {
      type: "stt-session-reset";
      sessionId: number;
    }
  | {
      type: "stt-session-close";
      sessionId: number;
    }
  | {
      type: "vad-load-model";
      modelId: string;
      persistentId?: string;
      modelAssetHost?: string;
      threshold?: number;
      minSilenceDurationSec?: number;
      minSpeechDurationSec?: number;
      maxSpeechDurationSec?: number;
    }
	  | {
	      type: "vad-detect";
	      samples: Float32Array;
	      sampleRate: number;
	    }
	  | {
	      type: "vad-create-session";
	    }
	  | {
	      type: "vad-session-push";
	      sessionId: number;
	      samples: Float32Array;
	      sampleRate: number;
	    }
	  | {
	      type: "vad-session-finish";
	      sessionId: number;
	    }
	  | {
	      type: "vad-session-reset";
	      sessionId: number;
	    }
	  | {
	      type: "vad-session-close";
	      sessionId: number;
	    };

export type WorkerRequest = WorkerRequestTemplate & { id: number };

export type WorkerResponse =
  | { id: number; type: "speech-load-model-done"; sampleRate: number; persistentId?: string }
  | { id: number; type: "speech-load-model-progress"; event: LoadModelProgressEvent }
  | { id: number; type: "speech-generate-done" }
  | { id: number; type: "request-error"; error: string }
  | {
      id: number;
      type: "speech-generate-chunk";
      samples: Float32Array;
      index: number;
      silencePaddingSec: number;
      progress: number;
      tRuntime: number;
      tPlayAudio: number;
      highlightStart: number;
      highlightEnd: number;
      textHighlightSegment?: number;
      text: string;
    }
  | { id: number; type: "speech-terminate-early-done" }
  | {
      id: number;
      type: "stt-load-model-progress";
      event: LoadModelProgressEvent;
    }
  | {
      id: number;
      type: "stt-load-model-done";
      family: string;
      supportsStreaming: boolean;
      persistentId?: string;
    }
  | {
      id: number;
      type: "stt-transcribe-done";
      result: TranscriptionResult;
    }
  | {
      id: number;
      type: "stt-create-session-done";
      sessionId: number;
    }
  | {
      id: number;
      type: "stt-session-push-done";
    }
  | {
      id: number;
      type: "stt-session-get-result-done";
      result: {
        text: string;
        modelId: string;
        isEndpoint: boolean;
        json: string;
      };
    }
  | {
      id: number;
      type: "stt-session-finish-done";
      result: {
        text: string;
        modelId: string;
        isEndpoint: boolean;
        json: string;
      };
    }
  | {
      id: number;
      type: "stt-session-reset-done";
    }
  | {
      id: number;
      type: "stt-session-close-done";
    }
  | {
      id: number;
      type: "vad-load-model-progress";
      event: LoadModelProgressEvent;
    }
  | {
      id: number;
      type: "vad-load-model-done";
      family: string;
      persistentId?: string;
    }
	  | {
	      id: number;
	      type: "vad-detect-done";
	      result: VadDetectionResult;
	    }
	  | {
	      id: number;
	      type: "vad-create-session-done";
	      sessionId: number;
	    }
	  | {
	      id: number;
	      type: "vad-session-push-done";
	      speechStarts: VadSpeechStartEvent[];
	      segments: VadSegment[];
	      emittedWindowCount: number;
	      speechStartCount: number;
	      speechEndCount: number;
	    }
	  | {
	      id: number;
	      type: "vad-session-finish-done";
	      segments: VadSegment[];
	      emittedWindowCount: number;
	      speechStartCount: number;
	      speechEndCount: number;
	    }
	  | {
	      id: number;
	      type: "vad-session-reset-done";
	    }
	  | {
	      id: number;
	      type: "vad-session-close-done";
	    };

export type SpeechGenerateWorkerOptions = {
  voiceId?: string | number;
  text: string;
  emotion?: TtsEmotion | string;
  intensity?: number;
  speed?: number;
  silencePaddingSec?: number;
};

export type SpeechGenerateDialogueWorkerSegment = {
  voiceId?: string | number;
  text: string;
  emotion?: TtsEmotion | string;
  intensity?: number;
  speed?: number;
  sentenceSilencePaddingSec?: number;
};

export type SpeechGenerateDialogueWorkerOptions = {
  segments: SpeechGenerateDialogueWorkerSegment[];
  speed?: number;
  silenceBetweenSegmentsSec?: number;
};

export type GetModelAssetsArgs = {
  modelId: string;
  platform: string;
  version: string;
};

export type ModelAssetsResponse = {
  model_onnx: string;
  model_tokens: string;
  wasm_binary: string;
  wasm_data?: string;
  espeak_data?: string;
  persistent_id?: string;
};

export type SttModelAssetsResponse = {
  family: string;
  tokens: string;
  wasm_binary: string;
  wasm_data?: string;
  encoder?: string;
  decoder?: string;
  preprocessor?: string;
  joiner?: string;
  uncached_decoder?: string;
  cached_decoder?: string;
  persistent_id?: string;
};

export type VadModelAssetsResponse = {
  family: string;
  model: string;
  wasm_binary: string;
  wasm_data?: string;
  persistent_id?: string;
};

export { TtsModel, loadTtsModel } from "./tts/model.js";
export { SttModel, loadSttModel } from "./stt/model.js";
export type {
  AudioResult,
  LoadModelProgressEvent,
  LoadTtsModelOptions,
  Timeline,
  TimelineChunk,
  TtsDialogueOptions,
  TtsDialogueSegment,
  TtsEmotion,
  TtsProgressEvent,
  TtsSynthesisResult,
  TtsSynthesizeOptions,
} from "./tts/types.js";
export type {
  DecodedAudio,
  LoadSttModelOptions,
  TranscribeOptions,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionToken,
} from "./stt/types.js";
export { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from "./tts/catalog.js";

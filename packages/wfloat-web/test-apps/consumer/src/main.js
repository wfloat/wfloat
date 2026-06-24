import {
  SPEAKER_IDS,
  VALID_EMOTIONS,
  VALID_SIDS,
  createMicrophoneCapture,
  loadLlmModel,
  loadSttModel,
  loadTtsModel,
  loadVadModel,
} from "@wfloat/wfloat-web";

window.__wfloatSmoke = {
  createMicrophoneCapture,
  loadLlmModel,
  loadSttModel,
  loadTtsModel,
  loadVadModel,
  speakerCount: Object.keys(SPEAKER_IDS).length,
  emotionCount: VALID_EMOTIONS.length,
  sidCount: VALID_SIDS.length,
};

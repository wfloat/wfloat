import {
  SPEAKER_IDS,
  VALID_EMOTIONS,
  VALID_SIDS,
  loadSttModel,
  loadTtsModel,
} from '../index';

describe('@wfloat/react-native-wfloat', () => {
  it('exports the v2 TTS and STT surfaces', () => {
    expect(typeof loadTtsModel).toBe('function');
    expect(typeof loadSttModel).toBe('function');
    expect(Array.isArray(VALID_EMOTIONS)).toBe(true);
    expect(Array.isArray(VALID_SIDS)).toBe(true);
    expect(typeof SPEAKER_IDS).toBe('object');
  });
});

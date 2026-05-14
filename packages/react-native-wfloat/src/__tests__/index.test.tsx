import {
  SPEAKER_IDS,
  VALID_EMOTIONS,
  VALID_SIDS,
  loadTtsModel,
} from '../index';

describe('@wfloat/react-native-wfloat', () => {
  it('exports the v2 TTS surface', () => {
    expect(typeof loadTtsModel).toBe('function');
    expect(Array.isArray(VALID_EMOTIONS)).toBe(true);
    expect(Array.isArray(VALID_SIDS)).toBe(true);
    expect(typeof SPEAKER_IDS).toBe('object');
  });
});

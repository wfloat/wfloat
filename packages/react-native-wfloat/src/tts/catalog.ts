import type { TtsEmotion } from './types';

export const VALID_EMOTIONS: TtsEmotion[] = [
  'neutral',
  'joy',
  'sadness',
  'anger',
  'fear',
  'surprise',
  'dismissive',
  'confusion',
];

export const SPEAKER_IDS: Record<string, number> = {
  skilled_hero_man: 0,
  skilled_hero_woman: 1,
  fun_hero_man: 2,
  fun_hero_woman: 3,
  strong_hero_man: 4,
  strong_hero_woman: 5,
  mad_scientist_man: 6,
  mad_scientist_woman: 7,
  clever_villain_man: 8,
  clever_villain_woman: 9,
  narrator_man: 10,
  narrator_woman: 11,
  wise_elder_man: 12,
  wise_elder_woman: 13,
  outgoing_anime_man: 14,
  outgoing_anime_woman: 15,
  scary_villain_man: 16,
  scary_villain_woman: 17,
  news_reporter_man: 18,
  news_reporter_woman: 19,
};

export const VALID_SIDS = Object.values(SPEAKER_IDS);

export type TtsEmotion =
  | 'neutral'
  | 'joy'
  | 'sadness'
  | 'anger'
  | 'fear'
  | 'surprise'
  | 'dismissive'
  | 'confusion';

export type LoadModelProgressEvent =
  | {
      status: 'downloading';
      progress: number;
    }
  | {
      status: 'loading';
    }
  | {
      status: 'completed';
    };

export type TtsProgressEvent = {
  progress: number;
  isPlaying: boolean;
  textHighlightStart: number;
  textHighlightEnd: number;
  text: string;
  textHighlightSegment?: number;
};

export type AudioResult = {
  sampleRate: number;
  durationSec: number;
};

export type TimelineChunk = {
  index: number;
  text: string;
  highlightStart: number;
  highlightEnd: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  progress: number;
  voice?: string | number;
  segmentIndex?: number;
};

export type Timeline = {
  chunks: TimelineChunk[];
  durationSec: number;
};

export type TtsSynthesisResult = {
  audio: AudioResult;
  timeline: Timeline;
  modelId: string;
  text: string;
};

export type TtsSynthesizeOptions = {
  text: string;
  voice?: string | number;
  emotion?: TtsEmotion | string;
  intensity?: number;
  speed?: number;
  silencePaddingSec?: number;
  autoPlay?: boolean;
  onProgress?: (event: TtsProgressEvent) => void;
  onFinishedPlaying?: () => void;
};

export type TtsDialogueSegment = {
  text: string;
  voice?: string | number;
  emotion?: TtsEmotion | string;
  intensity?: number;
  speed?: number;
  sentenceSilencePaddingSec?: number;
};

export type TtsDialogueOptions = {
  segments: TtsDialogueSegment[];
  speed?: number;
  silenceBetweenSegmentsSec?: number;
  autoPlay?: boolean;
  onProgress?: (event: TtsProgressEvent) => void;
  onFinishedPlaying?: () => void;
};

export type LoadTtsModelOptions = {
  onProgress?: (event: LoadModelProgressEvent) => void;
};

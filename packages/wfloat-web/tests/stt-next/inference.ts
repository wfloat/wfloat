// Compile-only public consumers: contextual inference, readonly views and distinct task surfaces.
import {
  loadSpeechToText, loadStreamingSpeechToText, TranscriptionError,
  type SpeechToTextModel, type StreamingSpeechToTextModel,
  type PcmAudio, type TranscriptionAudio, type Transcription, type TranscriptionSession,
  type TranscriptionResult, type LiveTranscriptionResult, type LivePartialTranscript,
  type TranscriptWord, type LiveTranscriptSegment, type RecognitionOptions,
} from '../../src/index.js';

const audio: PcmAudio = { samples: new Float32Array(160), sampleRate: 16000 };
declare const file: File;
declare const blob: Blob;
declare const buffer: AudioBuffer;
const inputs: readonly TranscriptionAudio[] = [audio, file, blob, buffer];
const model: SpeechToTextModel = await loadSpeechToText('model-id');
const live: StreamingSpeechToTextModel = await loadStreamingSpeechToText('model-id');
const recognition: RecognitionOptions = { language: 'en', task: 'translate', timestamps: 'word', hotwords: ['Wfloat'] as const };
for (const input of inputs) {
  const operation: Transcription = model.transcribe(input, { ...recognition, onTranscript(event) {
    const text: string = event.text;
    // @ts-expect-error Complete-audio notifications are whole-text previews, not live utterances.
    event.id;
    // @ts-expect-error Complete-audio previews do not expose finality.
    event.isFinal;
    // @ts-expect-error Notification views are readonly.
    event.text = text;
  } });
  const cancelled: void = operation.cancel();
  const result: TranscriptionResult = await operation.result();
  if (result.stopReason === 'complete') {
    const absent: undefined = result.provisional;
  } else {
    const provisional: string | undefined = result.provisional?.text;
  }
  const words: readonly TranscriptWord[] | undefined = result.words;
  // @ts-expect-error Complete-audio segments have no live utterance ID.
  result.segments?.[0].id;
  // @ts-expect-error No completion companion promise is public.
  operation.finished;
  // @ts-expect-error No public operation AbortSignal.
  operation.signal;
  // @ts-expect-error File operation is not a live-input session.
  operation.push(audio);
}

const session: TranscriptionSession = await live.createSession({ ...recognition, maxBufferedAudioMs: 5000,
  onTranscript(event) {
    const id: string = event.id;
    const final: boolean = event.isFinal;
    const text: string = event.text;
    const startMs: number | undefined = event.timing?.startMs;
    const words: readonly TranscriptWord[] | undefined = event.words;
    // @ts-expect-error Live event IDs are readonly.
    event.id = id;
    // @ts-expect-error Nested metadata is readonly.
    if (event.timing) event.timing.startMs = 0;
    // @ts-expect-error Word lists are readonly.
    event.words?.push({ text });
  },
  onError(error) {
    const standard: Error = error;
    const typed: TranscriptionError<LivePartialTranscript> = error;
    const segments: readonly LiveTranscriptSegment[] = error.partialResult.segments;
    const id: string = segments[0].id;
    const draft: string | undefined = error.partialResult.provisional?.text;
    const cause: unknown = error.cause;
    // @ts-expect-error Failure partials are not successful or cancelled results.
    error.partialResult.stopReason;
    // @ts-expect-error Live error segments are required and readonly.
    error.partialResult.segments = [];
  },
});
const accepted: Promise<void> = session.push(audio);
const microphone: Promise<void> = session.startMicrophone();
const completion: Promise<LiveTranscriptionResult> = session.finish();
const result: LiveTranscriptionResult = await session.result();
const segments: readonly LiveTranscriptSegment[] = result.segments;
const id: string = segments[0].id;
if (result.stopReason === 'complete') {
  const absent: undefined = result.provisional;
} else {
  const draft: string | undefined = result.provisional?.text;
}
// @ts-expect-error Results are readonly.
result.text = 'replacement';
// @ts-expect-error Segment lists are readonly.
result.segments.push({ id: '0', text: 'replacement' });
// @ts-expect-error Nested segment views are readonly.
result.segments[0].text = 'replacement';
// @ts-expect-error Live push only accepts explicit PCM.
session.push(blob);
// @ts-expect-error AudioBuffer belongs to complete-audio transcription, not push.
session.push(buffer);
// @ts-expect-error Samples alone omit their sample rate.
session.push(audio.samples);
// @ts-expect-error No public pause/resume lifecycle.
session.pause();
// @ts-expect-error File models expose no live creation surface.
model.createSession();
// @ts-expect-error Live models expose no complete-audio surface.
live.transcribe(audio);
// @ts-expect-error Public inference does not accept cancellation signals.
model.transcribe(audio, { signal: new AbortController().signal });
// @ts-expect-error No numerical inference progress callback.
model.transcribe(audio, { onProgress: () => {} });
// @ts-expect-error Recognition task is capability-checked and narrowly typed.
model.transcribe(audio, { task: 'summarize' });
// @ts-expect-error Unsupported timestamp spelling must not silently coerce.
live.createSession({ timestamps: 'token' });
// @ts-expect-error Hotwords are strings, not weighted tuples.
live.createSession({ hotwords: [['name', 2]] });
// @ts-expect-error No public session signal.
live.createSession({ signal: new AbortController().signal });
const unloadedFile: Promise<void> = model.unload();
const unloadedLive: Promise<void> = live.unload();

import { deferred, asError, notify } from '../tts-next/internal.js';
import { normalizeAudio, snapshotAudio } from './audio.js';
import type { SpeechToTextBackend } from './backend-types.js';
import { LiveSession } from './session.js';
import { appendTranscript, fileWindowLength, offsetTranscript, SAMPLE_RATE } from './transcript.js';
import { TranscriptionError, type PartialTranscript, type Transcription, type TranscriptionAudio,
  type TranscriptionResult, type TranscribeOptions, type TranscriptionSessionOptions,
  type TranscriptionSession, type RecognitionOptions } from './types.js';

export function recognitionOptions(options: RecognitionOptions): RecognitionOptions {
  if (!options || typeof options !== 'object') throw new TypeError('Recognition options must be an object.');
  if (options.language !== undefined && (typeof options.language !== 'string' || !options.language.trim())) throw new TypeError('language must be a nonempty string.');
  if (options.task !== undefined && options.task !== 'transcribe' && options.task !== 'translate') throw new TypeError('Unsupported transcription task.');
  if (options.timestamps !== undefined && options.timestamps !== 'segment' && options.timestamps !== 'word') throw new TypeError('timestamps must be segment or word.');
  if (options.hotwords !== undefined && (!Array.isArray(options.hotwords) || options.hotwords.some(word => typeof word !== 'string' || !word.trim()))) throw new TypeError('hotwords must contain nonempty strings.');
  return { ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(options.timestamps !== undefined ? { timestamps: options.timestamps } : {}),
    ...(options.hotwords !== undefined ? { hotwords: [...options.hotwords] } : {}) };
}
export function validateCallback(value: unknown, name: string) {
  if (value !== undefined && typeof value !== 'function') throw new TypeError(`${name} must be a function.`);
}

class FileTranscription implements Transcription {
  private completion = deferred<TranscriptionResult>();
  private terminal = false;
  private partial: PartialTranscript = { text: '' };
  private input: ReturnType<typeof snapshotAudio> | undefined;
  private lastPreview: string | undefined;
  constructor(audio: TranscriptionAudio, private options: TranscribeOptions, private done: () => void) {
    this.input = snapshotAudio(audio);
  }
  result() { return this.completion.promise; }
  cancel() {
    if (this.terminal) return;
    this.terminal = true; this.input = undefined;
    this.completion.resolve({ ...this.partial, stopReason: 'cancelled' }); this.done();
  }
  fail(cause: unknown) {
    if (this.terminal) return;
    this.terminal = true; this.input = undefined;
    const error = new TranscriptionError(asError(cause).message, this.partial, cause);
    this.completion.reject(error); this.done();
  }
  private preview(text: string) {
    if (text !== this.lastPreview) { this.lastPreview = text; notify(this.options.onTranscript, { text }); }
  }
  async run(backend: SpeechToTextBackend) {
    if (this.terminal) return;
    try {
      const snapshot = this.input!; this.input = undefined;
      const audio = await normalizeAudio(snapshot);
      if (this.terminal) return;
      await backend.configure(this.options);
      if (this.terminal) return;
      if (backend.kind === 'online') {
        await backend.openStream();
        let hypothesis = '';
        try {
          const step = Math.round(SAMPLE_RATE * 0.32);
          for (let start = 0; start < audio.samples.length && !this.terminal; start += step) {
            const end = Math.min(audio.samples.length, start + step);
            const result = await backend.pushStream(audio.samples.slice(start, end), end === audio.samples.length);
            if (this.terminal) return;
            hypothesis = result.text;
            if (result.isEndpoint || end === audio.samples.length) {
              this.partial = appendTranscript(this.partial, { text: hypothesis });
              hypothesis = '';
              if (end !== audio.samples.length) await backend.resetStream();
            } else this.partial = { ...this.partial, provisional: hypothesis ? { text: hypothesis } : undefined };
            if (this.terminal) return;
            this.preview(appendTranscript(this.partial, { text: hypothesis }).text);
          }
        } finally { await backend.closeStream(); }
      } else {
        for (let start = 0; start < audio.samples.length && !this.terminal;) {
          const length = fileWindowLength(audio.samples, start);
          const part = await backend.decode(audio.samples.slice(start, start + length));
          if (this.terminal) return;
          this.partial = appendTranscript(this.partial, offsetTranscript(part, start / SAMPLE_RATE * 1000));
          this.preview(this.partial.text);
          start += length;
        }
      }
      if (this.terminal) return;
      this.terminal = true;
      const { provisional: _, ...data } = this.partial;
      this.preview(data.text);
      this.completion.resolve({ ...data, stopReason: 'complete' }); this.done();
    } catch (error) { this.fail(error); }
  }
}

/** Internal owner serializes actual backend work, even after JS cancellation. */
export class SttModelOwner {
  private tail: Promise<void> = Promise.resolve();
  private files = new Set<FileTranscription>();
  private live?: LiveSession;
  private creating = false;
  private unloaded = false;
  private unloadPromise?: Promise<void>;
  private failure?: Error;
  constructor(private backend: SpeechToTextBackend) {
    backend.setFailureHandler?.(error => {
      this.failure = error;
      for (const file of [...this.files]) file.fail(error);
      this.live?.fail(error);
    });
  }
  private available() {
    if (this.unloaded) throw new Error('STT model is unloaded.');
    if (this.failure) throw this.failure;
  }
  private enqueue(work: () => Promise<void>) {
    const promise = this.tail.then(work);
    this.tail = promise.catch(() => {});
    return promise;
  }
  transcribe(audio: TranscriptionAudio, options: TranscribeOptions = {}): Transcription {
    this.available();
    if (this.live || this.creating) throw new Error('An active live session owns this model.');
    const config = recognitionOptions(options); this.backend.validate(config);
    validateCallback(options.onTranscript, 'onTranscript');
    const operation = new FileTranscription(audio, { ...config, onTranscript: options.onTranscript }, () => this.files.delete(operation));
    this.files.add(operation);
    void this.enqueue(() => operation.run(this.backend));
    return operation;
  }
  async createSession(options: TranscriptionSessionOptions = {}): Promise<TranscriptionSession> {
    this.available();
    if (this.live || this.creating || this.files.size) throw new Error('Model already has a live session or queued transcription.');
    const config = recognitionOptions(options); this.backend.validate(config);
    validateCallback(options.onTranscript, 'onTranscript'); validateCallback(options.onError, 'onError');
    if (options.maxBufferedAudioMs !== undefined && (!Number.isFinite(options.maxBufferedAudioMs) || options.maxBufferedAudioMs <= 0)) throw new RangeError('maxBufferedAudioMs must be positive and finite.');
    const sessionOptions = { ...config, onTranscript: options.onTranscript,
      onError: options.onError, maxBufferedAudioMs: options.maxBufferedAudioMs };
    this.creating = true;
    const ready = deferred<TranscriptionSession>();
    void this.enqueue(async () => {
      let session: LiveSession | undefined;
      let initialized = false;
      try {
        this.available();
        await this.backend.configure(config);
        this.available();
        if (this.backend.kind === 'online') await this.backend.openStream();
        this.available();
        session = new LiveSession(this.backend, sessionOptions, () => {
          if (this.live === session) this.live = undefined;
        });
        this.live = session; this.creating = false; initialized = true; ready.resolve(session);
        await session.released;
      } catch (error) { ready.reject(error); }
      finally {
        if (!initialized) this.creating = false;
        if (this.live === session) this.live = undefined;
        if (this.backend.kind === 'online') {
          try { await this.backend.closeStream(); } catch (error) { if (!this.unloaded) console.error('Wfloat STT stream cleanup failed:', error); }
        }
      }
    });
    return ready.promise;
  }
  unload(): Promise<void> {
    if (this.unloadPromise) return this.unloadPromise;
    this.unloaded = true;
    for (const file of [...this.files]) file.cancel();
    this.live?.cancel();
    this.unloadPromise = this.enqueue(() => this.backend.unload());
    return this.unloadPromise;
  }
}
export class SpeechToTextModel {
  private owner: SttModelOwner;
  /** @internal Constructed by loadSpeechToText. */
  constructor(backend: SpeechToTextBackend) { this.owner = new SttModelOwner(backend); }
  transcribe(audio: TranscriptionAudio, options?: TranscribeOptions): Transcription { return this.owner.transcribe(audio, options); }
  unload() { return this.owner.unload(); }
}
export class StreamingSpeechToTextModel {
  private owner: SttModelOwner;
  /** @internal Constructed by loadStreamingSpeechToText. */
  constructor(backend: SpeechToTextBackend) { this.owner = new SttModelOwner(backend); }
  createSession(options?: TranscriptionSessionOptions): Promise<TranscriptionSession> { return this.owner.createSession(options); }
  unload() { return this.owner.unload(); }
}

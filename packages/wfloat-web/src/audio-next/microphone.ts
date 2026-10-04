import { startMicrophone } from '../stt-next/microphone.js';
import type { PcmAudio } from '../stt-next/types.js';
import { asError, deferred } from '../tts-next/internal.js';

declare const captureBrand: unique symbol;
/** A prepared, shared microphone. Attach all sessions before calling start(). */
export interface MicrophoneCapture {
  readonly [captureBrand]: true;
  start(): Promise<void>;
  /** Terminal: releases capture without finishing attached sessions. */
  stop(): Promise<void>;
}

type Consumer = { audio: (audio: PcmAudio) => void; error: (error: Error) => void };
type Attachment = (onAudio: Consumer['audio'], onError: Consumer['error']) => () => void;
const attachments = new WeakMap<MicrophoneCapture, Attachment>();

/** @internal Only genuine helpers can be attached; no duck-typed capture sources. */
export function attachCapture(source: MicrophoneCapture, onAudio: Consumer['audio'], onError: Consumer['error']): () => void {
  const attach = attachments.get(source);
  if (!attach) throw new TypeError('Expected a MicrophoneCapture created by createMicrophoneCapture().');
  return attach(onAudio, onError);
}

export function createMicrophoneCapture(): MicrophoneCapture {
  return createMicrophoneCaptureWithFactory(startMicrophone);
}

/** @internal Capture injection for lifecycle tests; not a public capture option. */
export function createMicrophoneCaptureWithFactory(factory: typeof startMicrophone): MicrophoneCapture {
  let state: 'prepared' | 'starting' | 'running' | 'stopped' | 'failed' = 'prepared';
  const consumers = new Set<Consumer>();
  const abort = new AbortController();
  let capture: Awaited<ReturnType<typeof startMicrophone>> | undefined;
  let startup: ReturnType<typeof deferred<void>> | undefined;
  let closing: Promise<void> | undefined;
  const cancelled = () => new DOMException('Microphone startup cancelled', 'AbortError');
  const report = (error: unknown) => { console.error('Wfloat microphone consumer callback failed:', error); };
  const consumerError = (consumer: Consumer, cause: unknown) => {
    try { void Promise.resolve(consumer.error(asError(cause))).catch(report); }
    catch (error) { report(error); }
  };
  const close = () => {
    if (closing) return closing;
    const owned = capture; capture = undefined;
    // Abort only pending acquisition. A running capture's stop promise tracks cleanup.
    if (!owned) abort.abort();
    try { closing = owned ? Promise.resolve(owned.stop()) : Promise.resolve(); }
    catch (error) { closing = Promise.reject(error); }
    void closing.catch(() => {});
    return closing;
  };
  const fail = (cause: unknown) => {
    if (state === 'stopped' || state === 'failed') return;
    state = 'failed';
    const error = asError(cause);
    startup?.reject(error);
    const dependents = [...consumers]; consumers.clear();
    void close();
    for (const consumer of dependents) consumerError(consumer, error);
  };
  const deliver = (audio: PcmAudio) => {
    if (state !== 'starting' && state !== 'running') return;
    for (const consumer of [...consumers]) {
      if (state !== 'starting' && state !== 'running') break;
      if (!consumers.has(consumer)) continue;
      const rejected = (error: unknown) => {
        if (consumers.delete(consumer)) consumerError(consumer, error);
      };
      try {
        // Each dependent owns its copy, preserving source time/rate and sibling data.
        void Promise.resolve(consumer.audio({ samples: new Float32Array(audio.samples), sampleRate: audio.sampleRate })).catch(rejected);
      } catch (error) { rejected(error); }
    }
  };
  const helper = {
    start(): Promise<void> {
      if (state === 'stopped' || state === 'failed') {
        const rejected = Promise.reject(new Error('Microphone capture is terminal; create a new helper.'));
        void rejected.catch(() => {});
        return rejected;
      }
      if (startup) return startup.promise;
      startup = deferred<void>(); state = 'starting';
      try {
        // Do not defer factory invocation: Web Audio needs the user gesture stack.
        const acquisition = factory(deliver, fail, abort.signal);
        void acquisition.then(async acquired => {
          if (state !== 'starting') { await acquired.stop(); return; }
          capture = acquired; state = 'running'; startup!.resolve();
        }, error => fail(error)).catch(report);
      } catch (error) { fail(error); }
      return startup.promise;
    },
    stop(): Promise<void> {
      if (state !== 'failed' && state !== 'stopped') {
        state = 'stopped'; consumers.clear(); startup?.reject(cancelled());
      }
      return close();
    },
  } as MicrophoneCapture;
  attachments.set(helper, (onAudio, onError) => {
    if (state !== 'prepared') throw new Error('Microphone consumers must attach before capture starts.');
    const consumer = { audio: onAudio, error: onError }; consumers.add(consumer);
    return () => { consumers.delete(consumer); };
  });
  return helper;
}

import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { abortError, checkAbort, notify, request, subscribe, uniqueId } from '../platform/bridge';

export type BackgroundBehavior = 'continue' | 'pauseAndAutoResume' | 'pauseUntilResumed';
export type CaptureState = 'starting' | 'recording' | 'paused' | 'stopped' | 'failed';
export interface MicrophoneOptions {
  backgroundBehavior?: BackgroundBehavior;
  voiceProcessing?: boolean;
  onCaptureState?: (event: {state: CaptureState}) => void;
}
type Audio = { samples: Float32Array; sampleRate: number };
type Consumer = { audio: (audio: Audio) => void; error: (error: Error) => void };
declare const brand: unique symbol;
export interface MicrophoneCapture {
  readonly [brand]: true;
  start(): Promise<void>;
  stop(): Promise<void>;
}
const attachments = new WeakMap<MicrophoneCapture, (consumer: Consumer) => () => void>();
export function attachCapture(source: MicrophoneCapture, audio: Consumer['audio'], error: Consumer['error']): () => void {
  const attach = attachments.get(source);
  if (!attach) throw new TypeError('Expected a microphone created by createMicrophoneCapture().');
  return attach({audio,error});
}
export function validateBackground(value: unknown): void {
  if (value !== undefined && !['continue','pauseAndAutoResume','pauseUntilResumed'].includes(value as string)) throw new TypeError('Invalid backgroundBehavior.');
}
export function createMicrophoneCapture(options: MicrophoneOptions = {}): MicrophoneCapture {
  validateBackground(options.backgroundBehavior);
  if (options.voiceProcessing !== undefined && typeof options.voiceProcessing !== 'boolean') throw new TypeError('voiceProcessing must be a boolean.');
  if (options.onCaptureState !== undefined && typeof options.onCaptureState !== 'function') throw new TypeError('onCaptureState must be a function.');
  const initial = { ...options };
  const captureId = uniqueId('capture');
  const channelId = uniqueId('capture-channel');
  const consumers = new Set<Consumer>();
  let state: CaptureState | 'prepared' = 'prepared';
  let began = false;
  let nativeStarted = false;
  let replayAfterStart = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  let detachEvents: (() => void) | undefined;
  let detachApp: (() => void) | undefined;
  let sequence = 0;
  const pending = new Map<number, {sequence:number;samples:number[];sampleRate:number}>();
  let draining: Promise<void> | undefined;
  const transition = (next: CaptureState) => {
    if (state === next) return;
    state = next;
    queueMicrotask(() => notify(initial.onCaptureState, {state:next}));
  };
  const cleanup = () => {
    detachEvents?.(); detachEvents = undefined;
    detachApp?.(); detachApp = undefined;
    pending.clear();
  };
  const fail = (cause: unknown) => {
    if (state === 'failed' || state === 'stopped') return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    transition('failed');
    const targets = [...consumers]; consumers.clear();
    cleanup();
    void request({op:'micStop',captureId}).catch(error => console.error('Wfloat microphone cleanup failed:', error));
    for (const consumer of targets) notify(consumer.error, failure);
  };
  const deliver = (event: {sequence:number;samples:number[];sampleRate:number}) => {
    if (state === 'failed' || state === 'stopped' || event.sequence <= sequence) return;
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !(event.sampleRate > 0) || !Array.isArray(event.samples)) { fail(new Error('Invalid native microphone frame')); return; }
    pending.set(event.sequence,event);
    while (pending.has(sequence+1)) {
      const frame = pending.get(sequence+1)!; pending.delete(++sequence);
      for (const consumer of [...consumers]) {
        if (!consumers.has(consumer)) continue;
        try { consumer.audio({ samples: Float32Array.from(frame.samples), sampleRate: frame.sampleRate }); }
        catch (error) { consumers.delete(consumer); notify(consumer.error, error instanceof Error ? error : new Error(String(error))); }
      }
    }
    void request({op:'micAck',captureId,sequence}).catch(fail);
  };
  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = request<Array<{sequence:number;samples:number[];sampleRate:number}>>({op:'micDrain',captureId,afterSequence:sequence})
      .then(events => { for (const event of events) deliver(event); })
      .catch(fail).finally(() => { draining = undefined; });
    return draining;
  };
  const connect = () => {
    if (detachEvents) return;
    detachEvents = subscribe(channelId,event => {
      if (state === 'failed' || state === 'stopped') return;
      if (event.type === 'audio') { deliver(event); if (pending.size) void drain(); }
      else if (event.type === 'warning') console.warn(event.message);
      else if (event.type === 'error') fail(new Error(event.message));
      else if (event.type === 'captureState') {
        if (event.state === 'failed') fail(new Error(event.message ?? 'Microphone capture failed'));
        else if (['starting','recording','paused'].includes(event.state)) transition(event.state);
      }
    });
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active' || !began || state === 'failed' || state === 'stopped' || closing) return;
      // Permission sheets can foreground the app before native capture exists.
      if (!nativeStarted || starting) replayAfterStart = true;
      else void drain();
    });
    detachApp = () => subscription.remove();
  };
  const helper = {
    start(): Promise<void> {
      if (closing || state === 'stopped' || state === 'failed') return Promise.reject(failure ?? new Error('Microphone is terminal; create a new capture.'));
      if (starting) return starting;
      if (state === 'recording') return Promise.resolve();
      began = true; connect(); transition('starting');
      starting = (async () => {
        if (Platform.OS === 'android') {
          const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO!;
          if (!await PermissionsAndroid.check(permission)) {
            const result = await PermissionsAndroid.request(permission);
            if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission was denied.');
          }
        }
        if (closing || failure) throw failure ?? abortError();
        return request<{state?:CaptureState}|null>({op:'micStart',captureId,options:{backgroundBehavior:initial.backgroundBehavior ?? 'pauseUntilResumed',voiceProcessing:initial.voiceProcessing ?? false}}, {requestId:channelId});
      })()
        .then(result => {
          if (closing || failure) throw failure ?? abortError();
          nativeStarted = true;
          // Native owns background/interruption state; never overwrite a paused event.
          if (state === 'starting') transition(result?.state === 'paused' ? 'paused' : 'recording');
          if (replayAfterStart) { replayAfterStart = false; void drain(); }
        }).catch(error => { if (!closing) fail(error); throw error; }).finally(() => { starting = undefined; });
      void starting.catch(() => {});
      return starting;
    },
    stop(): Promise<void> {
      if (closing) return closing;
      if (state === 'stopped') return Promise.resolve();
      const wasFailed = state === 'failed';
      closing = (async () => {
        // Native stop fences pending startup and returns retained undelivered audio.
        if (began) {
          const frames = await request<Array<{sequence:number;samples:number[];sampleRate:number}>|null>({op:'micStop',captureId});
          if (Array.isArray(frames)) for (const frame of frames) deliver(frame);
        }
        if (!wasFailed) transition('stopped');
      })().catch(error => { fail(error); throw error; }).finally(() => { cleanup(); consumers.clear(); });
      return closing;
    },
  } as MicrophoneCapture;
  attachments.set(helper, consumer => {
    if (began || state !== 'prepared' || closing) throw new Error('Attach microphone consumers before its first start().');
    consumers.add(consumer);
    return () => { consumers.delete(consumer); };
  });
  return helper;
}
/** Internal session-owned adapter. Starting again resumes the same capture policy. */
export async function startMicrophone(onAudio: Consumer['audio'], onError: Consumer['error'], signal?: AbortSignal, options: MicrophoneOptions = {}): Promise<{start():Promise<void>;stop():Promise<void>}> {
  checkAbort(signal);
  const capture = createMicrophoneCapture(options);
  const detach = attachCapture(capture,onAudio,onError);
  const stop = async () => {
    signal?.removeEventListener('abort',abort);
    // Native stop fences capture and returns any final, unacknowledged frames.
    try { await capture.stop(); } finally { detach(); }
  };
  const abort = () => { void stop().catch(error => console.error('Wfloat capture cancellation failed:',error)); };
  signal?.addEventListener('abort',abort,{once:true});
  try { await capture.start(); checkAbort(signal); }
  catch (error) { await stop(); throw error; }
  return {start:()=>capture.start(),stop};
}

import type { PcmAudio } from './types.js';

export type MicrophoneCapture = { stop(): Promise<void> };

const processorSource = `
class SttCapture extends AudioWorkletProcessor {
  constructor() { super(); this.hadInput = false; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0].length) {
      if (this.hadInput) { this.port.postMessage({ error: 'Microphone audio input disconnected' }); return false; }
      return true;
    }
    this.hadInput = true;
    const samples = new Float32Array(channels[0].length);
    for (let i = 0; i < samples.length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      samples[i] = value;
    }
    this.port.postMessage({ samples }, [samples.buffer]);
    return true;
  }
}
registerProcessor('wfloat-stt-capture', SttCapture);
`;

function applicationError(error: unknown): void {
  const report = (globalThis as unknown as { reportError?: (error: unknown) => void }).reportError;
  if (report) report(error);
  else setTimeout(() => { throw error; }, 0);
}

function notify<T>(callback: (value: T) => void, value: T): void {
  try {
    // Also observe async callbacks without making capture wait on application code.
    Promise.resolve(callback(value)).catch(applicationError);
  } catch (error) { applicationError(error); }
}

/**
 * Owns capture only: delivers fresh mono PCM at the device context's sample rate,
 * with no recording retained. Construction/resume happens before the first await
 * to preserve user activation. The internal signal cancels permission startup
 * promptly; any stream granted after cancellation is immediately stopped.
 * Startup failures reject; failures after startup notify onError once and stop.
 */
export function startMicrophone(
  onAudio: (pcm: PcmAudio) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
): Promise<MicrophoneCapture> {
  const aborted = () => new DOMException('Microphone startup cancelled', 'AbortError');
  if (signal?.aborted) return Promise.reject(aborted());
  const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context || !globalThis.navigator?.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('Microphone capture requires Web Audio and getUserMedia'));
  }
  let context: AudioContext;
  let resumed: Promise<void>;
  try {
    context = new Context();
  } catch (error) { return Promise.reject(error); }
  try {
    resumed = context.resume();
  } catch (error) {
    void context.close().catch(() => {});
    return Promise.reject(error);
  }

  return new Promise<MicrophoneCapture>((resolve, reject) => {
    let stream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let processor: AudioWorkletNode | ScriptProcessorNode | undefined;
    let gain: GainNode | undefined;
    let started = false;
    let stopped = false;
    let closing: Promise<void> | undefined;
    let moduleUrl: string | undefined;
    const listeners: Array<() => void> = [];
    const listen = (target: EventTarget, event: string, callback: EventListener) => {
      target.addEventListener(event, callback);
      listeners.push(() => target.removeEventListener(event, callback));
    };
    const releaseUrl = () => {
      if (moduleUrl) { URL.revokeObjectURL(moduleUrl); moduleUrl = undefined; }
    };
    const stop = (): Promise<void> => {
      if (closing) return closing;
      stopped = true;
      for (const remove of listeners) remove();
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (processor) {
        if ('port' in processor) {
          processor.port.onmessage = null;
          processor.port.onmessageerror = null;
          processor.port.close();
          processor.onprocessorerror = null;
        } else processor.onaudioprocess = null;
      }
      for (const node of [source, processor, gain]) {
        try { node?.disconnect(); } catch { /* Already disconnected. */ }
      }
      releaseUrl();
      try { closing = Promise.resolve(context.close()); }
      catch (error) { closing = Promise.reject(error); }
      // Internal cleanup paths may not have a caller waiting on stop().
      void closing.catch(() => {});
      return closing;
    };
    const fail = (cause: unknown) => {
      if (stopped) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      void stop();
      if (started) notify(onError, error);
      else reject(error);
    };
    const cancel = () => {
      if (stopped) return;
      void stop();
      if (!started) reject(aborted());
    };
    if (signal) {
      listen(signal, 'abort', cancel);
      if (signal.aborted) cancel();
    }
    // A rejected resume must be observed even while permission remains pending.
    void resumed.catch(fail);
    if (stopped) return;
    listen(context, 'statechange', () => {
      if (context.state === 'closed' || (started && context.state !== 'running')) {
        fail(new Error('Microphone audio context stopped'));
      }
    });
    const deliver = (samples: Float32Array) => {
      if (stopped || !started) return;
      if (!samples.length || samples.some(value => !Number.isFinite(value))) {
        fail(new Error('Invalid microphone audio input'));
        return;
      }
      notify(onAudio, { samples, sampleRate: context.sampleRate });
    };
    void (async () => {
      if (stopped) return;
      const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) { for (const track of captured.getTracks()) track.stop(); return; }
      stream = captured;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some(track => track.readyState === 'ended')) throw new Error('Microphone audio input disconnected');
      for (const track of tracks) listen(track, 'ended', () => fail(new Error('Microphone audio input disconnected')));
      listen(stream, 'inactive', () => fail(new Error('Microphone stream became inactive')));
      await resumed;
      if (stopped) return;
      source = context.createMediaStreamSource(stream);
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          moduleUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
          await context.audioWorklet.addModule(moduleUrl);
          if (stopped) return;
          const worklet = new AudioWorkletNode(context, 'wfloat-stt-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          });
          processor = worklet;
          worklet.port.onmessage = event => {
            if (event.data?.error) fail(new Error(event.data.error));
            else if (event.data?.samples instanceof Float32Array) deliver(event.data.samples);
            else fail(new Error('Invalid microphone worklet message'));
          };
          worklet.port.onmessageerror = () => fail(new Error('Microphone worklet message failed'));
          worklet.onprocessorerror = () => fail(new Error('Microphone worklet failed'));
        } catch (error) {
          if (stopped) return;
          // Blob modules can be blocked by CSP even when AudioWorklet exists.
          // Fall back only during setup, never after a running capture fails.
          if (typeof context.createScriptProcessor !== 'function') throw error;
        } finally { releaseUrl(); }
      }
      if (stopped) return;
      if (!processor) {
        // Request actual track channel count where available; never discard a
        // stereo channel by requesting mono before the explicit downmix.
        const channels = tracks[0].getSettings().channelCount ?? 2;
        const legacy = context.createScriptProcessor(4096, channels, 1);
        processor = legacy;
        legacy.onaudioprocess = event => {
          if (stopped) return;
          try {
            const input = event.inputBuffer;
            if (!input.numberOfChannels || !input.length) throw new Error('Microphone audio input disconnected');
            const samples = new Float32Array(input.length);
            for (let i = 0; i < input.length; i++) {
              let value = 0;
              for (let channel = 0; channel < input.numberOfChannels; channel++) value += input.getChannelData(channel)[i] / input.numberOfChannels;
              samples[i] = value;
            }
            deliver(samples);
          } catch (error) { fail(error); }
        };
      }
      gain = context.createGain();
      gain.gain.value = 0;
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      if (context.state !== 'running') throw new Error('Microphone audio context is not running');
      started = true;
      resolve({ stop });
    })().catch(fail);
  });
}

export type MicrophoneCaptureOptions = {
  sampleRate?: number;
  channelCount?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
};

export type MicrophoneChunkCallback = (samples: Float32Array, sampleRate: number) => void | Promise<void>;

export type CapturedMicrophoneAudio = {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
};

export interface MicrophoneCapture {
  readonly sampleRate: number;
  readonly isRecording: boolean;
  start(options?: { onChunk?: MicrophoneChunkCallback }): Promise<void>;
  stop(): Promise<CapturedMicrophoneAudio>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

function mixToMono(inputBuffer: AudioBuffer): Float32Array {
  if (inputBuffer.numberOfChannels <= 1) {
    return new Float32Array(inputBuffer.getChannelData(0));
  }

  const output = new Float32Array(inputBuffer.length);
  for (let channel = 0; channel < inputBuffer.numberOfChannels; channel += 1) {
    const channelData = inputBuffer.getChannelData(channel);
    for (let i = 0; i < channelData.length; i += 1) {
      output[i] += channelData[i];
    }
  }

  const scale = 1 / inputBuffer.numberOfChannels;
  for (let i = 0; i < output.length; i += 1) {
    output[i] *= scale;
  }

  return output;
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

class BrowserMicrophoneCapture implements MicrophoneCapture {
  private readonly options: Required<MicrophoneCaptureOptions>;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sinkNode: GainNode | null = null;
  private recordedChunks: Float32Array[] = [];
  private started = false;
  private recording = false;
  private onChunk: MicrophoneChunkCallback | null = null;

  constructor(options: MicrophoneCaptureOptions) {
    this.options = {
      sampleRate: options.sampleRate ?? 16000,
      channelCount: options.channelCount ?? 1,
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
    };
  }

  get sampleRate(): number {
    return this.audioContext?.sampleRate ?? this.options.sampleRate;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  async start(options: { onChunk?: MicrophoneChunkCallback } = {}): Promise<void> {
    if (this.recording) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is not available in this environment.");
    }

    if (typeof AudioContext === "undefined") {
      throw new Error("AudioContext is not available in this environment.");
    }

    this.recordedChunks = [];
    this.onChunk = options.onChunk ?? null;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: this.options.channelCount,
        echoCancellation: this.options.echoCancellation,
        noiseSuppression: this.options.noiseSuppression,
        autoGainControl: this.options.autoGainControl,
      },
      video: false,
    });

    const audioContext = new AudioContext({
      sampleRate: this.options.sampleRate,
    });
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const processorNode = audioContext.createScriptProcessor(4096, this.options.channelCount, 1);
    const sinkNode = audioContext.createGain();
    sinkNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!this.recording) {
        return;
      }

      const mono = mixToMono(event.inputBuffer);
      const samples = new Float32Array(mono);
      this.recordedChunks.push(samples);
      void this.onChunk?.(samples, this.sampleRate);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(sinkNode);
    sinkNode.connect(audioContext.destination);

    this.audioContext = audioContext;
    this.mediaStream = stream;
    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
    this.sinkNode = sinkNode;
    this.started = true;
    this.recording = true;
  }

  async stop(): Promise<CapturedMicrophoneAudio> {
    if (!this.started) {
      throw new Error("Microphone capture has not started.");
    }

    if (!this.recording) {
      return this.buildResult();
    }

    this.recording = false;
    await this.teardown();
    return this.buildResult();
  }

  async cancel(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.recording = false;
    this.recordedChunks = [];
    this.onChunk = null;
    await this.teardown();
  }

  async close(): Promise<void> {
    await this.cancel();
  }

  private buildResult(): CapturedMicrophoneAudio {
    const samples = concatChunks(this.recordedChunks);
    return {
      samples,
      sampleRate: this.sampleRate,
      durationSec: samples.length / this.sampleRate,
    };
  }

  private async teardown(): Promise<void> {
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.sinkNode?.disconnect();
    this.processorNode = null;
    this.sourceNode = null;
    this.sinkNode = null;
    this.onChunk = null;

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.started = false;
  }
}

export async function createMicrophoneCapture(
  options: MicrophoneCaptureOptions = {},
): Promise<MicrophoneCapture> {
  return new BrowserMicrophoneCapture(options);
}

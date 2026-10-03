// Bundled by the parent into dist/tts-next/tts-worker.js. One worker per loaded model.
// @ts-ignore Generated Emscripten factory has no TypeScript declaration.
import createSherpaSpeechModule from '../wasm/sherpa-onnx-wasm-main-speech.js';
import type { OfflineTts, SherpaModule } from '../wasm/sherpa-onnx-tts.js';
import type { WorkerRequest, WorkerResponse } from './backend.js';
import { initializeSherpa, prepareSherpa, synthesizeSherpa } from './sherpa.js';
import { asError } from './internal.js';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
let module: SherpaModule | undefined;
let tts: OfflineTts | undefined;
// Serialize even if a consumer bypasses the model scheduler.
let queue = Promise.resolve();
scope.onmessage = event => {
  queue = queue.then(async () => {
    const request = event.data;
    try {
      if (request.type === 'init') {
        if (tts) throw new Error('TTS worker is already initialized.');
        module = await createSherpaSpeechModule({ wasmBinary: request.assets.wasm, print: () => {}, printErr: (text: string) => console.error('sherpa:', text) });
        tts = initializeSherpa(module!, request.assets);
        scope.postMessage({ id: request.id, value: { sampleRate: tts.sampleRate } });
      } else {
        if (!tts || !module) throw new Error('TTS worker is not initialized.');
        if (request.type === 'prepare') scope.postMessage({ id: request.id, value: prepareSherpa(module, tts, request.segment) });
        else {
          const audio = synthesizeSherpa(tts, request.unit, request.segment);
          scope.postMessage({ id: request.id, value: audio }, [audio.samples.buffer as ArrayBuffer]);
        }
      }
    } catch (value) {
      const error = asError(value);
      scope.postMessage({ id: request.id, error: { message: error.message, name: error.name, stack: error.stack } });
    }
  });
};

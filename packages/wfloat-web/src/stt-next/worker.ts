// Parent bundles this entry as dist/stt-next/stt-worker.js; one worker per model.
// @ts-ignore Generated Emscripten factory has no declaration.
import createSherpaSpeechModule from '../wasm/sherpa-onnx-wasm-main-speech.js';
import { NativeDiagnostics, SherpaRecognizer } from './sherpa.js';
import type { WorkerRequest, WorkerResponse } from './backend-types.js';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(response: WorkerResponse): void;
};
let recognizer: SherpaRecognizer | undefined;
let initialized = false;
let queue = Promise.resolve();
const diagnostics = new NativeDiagnostics();
const serializeError = (value: unknown) => {
  const error = value instanceof Error ? value : new Error(String(value));
  return { name: error.name, message: error.message, stack: error.stack };
};
scope.onmessage = event => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (request.type === 'init') {
        if (initialized) throw new Error('STT worker is already initialized.');
        initialized = true;
        const module = await createSherpaSpeechModule({
          wasmBinary: request.assets.wasm, print: diagnostics.print, printErr: diagnostics.print,
          onAbort: (reason: unknown) => scope.postMessage({ id: request.id, fatal: true, error: serializeError(reason) }),
        });
        recognizer = new SherpaRecognizer(module, request.modelId, request.assets, diagnostics);
      } else if (request.type === 'unload') {
        recognizer?.unload(); recognizer = undefined;
      } else {
        if (!recognizer) throw new Error('STT worker is not initialized.');
        switch (request.type) {
          case 'configure': value = recognizer.configure(request.options); break;
          case 'decode': value = recognizer.decode(request.samples); break;
          case 'open': value = recognizer.openStream(); break;
          case 'push': value = recognizer.pushStream(request.samples, request.finish); break;
          case 'reset': value = recognizer.resetStream(); break;
          case 'close': value = recognizer.closeStream(); break;
        }
      }
      scope.postMessage({ id: request.id, value });
    } catch (error) {
      // A request failure must not terminate other work or the loaded instance.
      scope.postMessage({ id: request.id, error: serializeError(error) });
    }
  });
};

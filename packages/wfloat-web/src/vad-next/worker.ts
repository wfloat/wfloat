// Bundle as dist/vad-next/vad-worker.js; one dedicated worker per model.
// @ts-ignore Generated Emscripten factory has no declaration.
import createSherpaSpeechModule from '../wasm/sherpa-onnx-wasm-main-speech.js';
import { SherpaVadScorer } from './sherpa.js';
import type { WorkerRequest, WorkerResponse } from './backend-types.js';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(response: WorkerResponse): void;
};
let scorer: SherpaVadScorer | undefined;
let initialized = false;
let fatal = false;
let queue = Promise.resolve();
let messages: string[] = [];
const print = (value: unknown) => { messages.push(String(value)); if (messages.length > 16) messages.shift(); };
const serializeError = (value: unknown) => {
  const error = value instanceof Error ? value : new Error(String(value));
  return { name: error.name, message: error.message, stack: error.stack };
};
scope.onmessage = event => {
  const request = event.data;
  queue = queue.then(async () => {
    if (fatal) return;
    messages = [];
    try {
      let value: unknown;
      if (request.type === 'init') {
        if (initialized) throw new Error('VAD worker is already initialized.');
        initialized = true;
        const module = await createSherpaSpeechModule({
          wasmBinary: request.assets.wasm, print, printErr: print,
          onAbort: (reason: unknown) => {
            fatal = true;
            scope.postMessage({ id: request.id, fatal: true, error: serializeError(reason) });
          },
        });
        if (fatal) return;
        scorer = new SherpaVadScorer(module, request.modelId, request.assets);
      } else if (request.type === 'unload') {
        scorer?.unload(); scorer = undefined;
      } else {
        if (!scorer) throw new Error('VAD worker is not initialized.');
        if (request.type === 'reset') scorer.reset();
        else if (request.type === 'score') value = scorer.score(request.samples);
      }
      if (!fatal) scope.postMessage({ id: request.id, value });
    } catch (error) {
      if (fatal) return;
      // Stateful native failures cannot safely continue with subsequent frames.
      fatal = true;
      const serialized = serializeError(error);
      if (messages.length) serialized.message += `\n${messages.join('\n')}`;
      scope.postMessage({ id: request.id, fatal: true, error: serialized });
    }
  });
};

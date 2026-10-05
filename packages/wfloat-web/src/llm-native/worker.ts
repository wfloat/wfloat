import { NativeRuntime } from './runtime.js';
import type { WorkerCommand, WorkerReply } from './types.js';
// DOM and WebWorker lib declarations conflict in consumers, so declare the small boundary explicitly.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
  postMessage(reply: WorkerReply): void;
};
let runtime: NativeRuntime | undefined;
let active: { id: number; abort: boolean } | undefined;
let loading = false;
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
scope.onmessage = event => { void dispatch(event.data); };
async function dispatch(command: WorkerCommand): Promise<void> {
  const id = command.id;
  if (command.type === 'abort') { if (active?.id === id) active.abort = true; return; }
  try {
    if (command.type === 'load') {
      if (runtime || loading) throw new Error('This worker already owns a model.');
      loading = true;
      try { runtime = await NativeRuntime.load(command.options); }
      finally { loading = false; }
      scope.postMessage({ id, type: 'result', value: runtime.contextSize }); return;
    }
    if (!runtime) throw new Error('Native model is not loaded.');
    if (command.type === 'schema') {
      scope.postMessage({ id, type: 'result', value: runtime.schema(command.schema, command.value, command.validate) }); return;
    }
    if (command.type === 'count') {
      scope.postMessage({ id, type: 'result', value: runtime.count(command.request) }); return;
    }
    if (active) throw new Error('A round is already running on this model.');
    if (command.type === 'unload') {
      runtime.unload(); runtime = undefined;
      scope.postMessage({ id, type: 'result', value: null }); return;
    }
    active = { id, abort: false };
    try {
      runtime.begin(command.request);
      let done = false;
      while (!done) {
        // A real task yield, not a microtask: permits abort/count/schema messages.
        await yieldTask();
        for (const event of runtime.step(active.abort)) {
          scope.postMessage({ id, type: 'event', event });
          if (event.type === 'done') done = true;
        }
      }
    } finally { runtime.end(); active = undefined; }
  } catch (error) {
    scope.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

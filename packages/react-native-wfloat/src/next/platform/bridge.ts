import { signalReason } from './cancellation';
import { nativeRuntime } from '../../NativeWfloatNext';

let serial = 0;
const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export function uniqueId(kind = 'request'): string { return `${kind}-${prefix}-${++serial}`; }
export function abortError(): Error { const error = new Error('Operation aborted'); error.name = 'AbortError'; return error; }
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) { const reason = signalReason(signal); throw reason instanceof Error ? reason : abortError(); }
}
export function reportCallback(error: unknown): void { console.error('Wfloat callback failed:', error); }
export function notify<T>(callback: ((event: T) => void) | undefined, event: T): void {
  try { void Promise.resolve(callback?.(event)).catch(reportCallback); } catch (error) { reportCallback(error); }
}
export function subscribe(requestId: string, callback: (event: any) => void): () => void {
  const listener = nativeRuntime().onEvent(event => {
    if (event.requestId !== requestId) return;
    let payload: unknown;
    try { payload = JSON.parse(event.payload); }
    catch (error) { reportCallback(error); return; }
    notify(callback, payload);
  });
  return () => listener.remove();
}
export interface RequestOptions {
  signal?: AbortSignal;
  onEvent?: (event: any) => void;
  requestId?: string;
}
export async function request<T = unknown>(command: Record<string, unknown>, options: RequestOptions = {}): Promise<T> {
  checkAbort(options.signal);
  const id = options.requestId ?? uniqueId();
  const runtime = nativeRuntime();
  const detach = options.onEvent ? subscribe(id, options.onEvent) : () => {};
  const cancel = () => runtime.cancel(id);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkAbort(options.signal);
    const encoded = JSON.stringify(command);
    const pending = runtime.request(id, encoded);
    // Close the synchronous-dispatch/abort race without abandoning native cleanup.
    if (options.signal?.aborted) cancel();
    const result = await pending;
    checkAbort(options.signal);
    return JSON.parse(result) as T;
  } catch (error) {
    checkAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    detach();
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // An unobserved companion promise must not cause an unhandled rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
export function notify<T>(callback: ((event: T) => void) | undefined, event: T): void {
  if (!callback) return;
  queueMicrotask(() => {
    try { void Promise.resolve(callback(event)).catch(reportCallbackError); }
    catch (error) { reportCallbackError(error); }
  });
}
function reportCallbackError(error: unknown) { console.error('Wfloat application callback failed:', error); }
export function closedError() { return new Error('Speech generation has been disposed.'); }

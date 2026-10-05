/** RN 0.76's AbortController does not retain reasons. Decorate only SDK-owned
 * signals, preserving interoperability with fetch without replacing globals. */
const reasons = new WeakMap<AbortSignal, unknown>();
export function signalReason(signal: AbortSignal): unknown {
  return reasons.has(signal) ? reasons.get(signal) : (signal as AbortSignal & {reason?: unknown}).reason;
}
export class OperationController extends AbortController {
  constructor() {
    super();
    const signal = this.signal;
    if (!('reason' in signal)) Object.defineProperty(signal, 'reason', { get: () => reasons.get(signal) });
    if (!('throwIfAborted' in signal)) Object.defineProperty(signal, 'throwIfAborted', {
      value: () => { if (signal.aborted) throw signalReason(signal); },
    });
  }
  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    if (reason === undefined) reason = Object.assign(new Error('Operation aborted'), {name:'AbortError'});
    reasons.set(this.signal, reason);
    (super.abort as (reason?: unknown) => void).call(this, reason);
  }
}

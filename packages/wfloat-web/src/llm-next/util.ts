import type { JsonValue, PartialGenerationResult, ToolCall, ToolMessage } from './types';

export class GenerationError extends Error {
  readonly name = 'GenerationError';
  readonly cause?: unknown;
  constructor(message: string, readonly partialResult: PartialGenerationResult, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  const error = new Error(String(value));
  Object.defineProperty(error, 'cause', { value });
  return error;
}
/** Notifications are observations, never backpressure or operation control. */
export function notify<T>(callback: ((event: T) => unknown) | undefined, event: T): void {
  if (!callback) return;
  const report = (error: unknown) => {
    const reporter = (globalThis as typeof globalThis & { reportError?: (error: unknown) => void }).reportError;
    if (reporter) reporter(error);
    else console.error('Wfloat application callback failed:', error);
  };
  try { Promise.resolve(callback(event)).catch(report); } catch (error) { report(error); }
}
export function jsonValue(value: unknown, seen = new Set<unknown>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Tool output must be a finite, acyclic JSON value.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('Tool output must contain only plain JSON objects and arrays.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) jsonValue(value[i], seen);
  } else {
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Tool output cannot contain symbol keys.');
    for (const item of Object.values(value)) jsonValue(item, seen);
  }
  seen.delete(value);
}
export function toolResult(call: ToolCall, output: JsonValue): ToolMessage {
  jsonValue(output);
  return { role: 'tool', callId: call.id, status: 'completed', output: structuredClone(output), createdAt: new Date().toISOString() };
}
/** Hold only the suffix that may become a stop string across token boundaries. */
export class StopFilter {
  private pending = '';
  stopped = false;
  constructor(private readonly strings: readonly string[]) {}
  push(text: string): string {
    if (this.stopped) return '';
    this.pending += text;
    let first = -1;
    let firstEnd = Infinity;
    for (const stop of this.strings) {
      const i = this.pending.indexOf(stop);
      if (i >= 0 && i + stop.length < firstEnd) { first = i; firstEnd = i + stop.length; }
    }
    if (first >= 0) {
      const output = this.pending.slice(0, first);
      this.pending = ''; this.stopped = true; return output;
    }
    let keep = 0;
    for (const stop of this.strings) {
      for (let n = Math.min(stop.length - 1, this.pending.length); n > keep; n--) {
        if (this.pending.endsWith(stop.slice(0, n))) { keep = n; break; }
      }
    }
    const output = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return output;
  }
  flush(): string { const output = this.pending; this.pending = ''; return output; }
}

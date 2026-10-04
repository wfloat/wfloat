import { request, uniqueId } from '../platform/bridge';

/** One native model identity; all adapters share the same teardown discipline. */
export class NativeInstance {
  readonly instanceId = uniqueId('model');
  private closed = false;
  private closing?: Promise<void>;
  call<T>(op: string, fields: Record<string, unknown> = {}, options?: { signal?: AbortSignal; onEvent?: (event: any) => void }): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Native model is unloaded.'));
    return request<T>({ ...fields, op, instanceId: this.instanceId }, options);
  }
  unload(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = request<void>({ op: 'unload', instanceId: this.instanceId });
    }
    return this.closing;
  }
}

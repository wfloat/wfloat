export type FileDescriptorSample = {
  platform: 'android'; source: '/proc/self/fd'; scope: 'calling_process'; unit: 'descriptors'; atomicSnapshot: false;
  count: number | null; availability: 'available' | 'error'; reason: string | null;
  excludedCollectorDescriptor: number | null;
  processId: number; observationId: string; sequence: number;
  clockSource: 'SystemClock.elapsedRealtimeNanos'; queryStartedUptimeMs: number; queryFinishedUptimeMs: number;
  sampledAtMs: number; osVersion: string; apiLevel: number; buildFingerprint: string; debugBuild: boolean;
};
const descriptorInteger = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
export function validateFileDescriptorSample(value: unknown): FileDescriptorSample {
  const s = value as FileDescriptorSample;
  if (!s || s.platform !== 'android' || s.source !== '/proc/self/fd' || s.scope !== 'calling_process' ||
      s.unit !== 'descriptors' || s.atomicSnapshot !== false || s.clockSource !== 'SystemClock.elapsedRealtimeNanos' ||
      ![s.processId, s.sequence, s.apiLevel].every(n => Number.isSafeInteger(n) && n > 0) || s.apiLevel < 24 ||
      ![s.observationId, s.osVersion, s.buildFingerprint].every(v => typeof v === 'string' && v.trim()) ||
      typeof s.debugBuild !== 'boolean' || !Number.isFinite(s.sampledAtMs) || s.sampledAtMs <= 0 ||
      ![s.queryStartedUptimeMs, s.queryFinishedUptimeMs].every(n => Number.isFinite(n) && n >= 0) ||
      s.queryFinishedUptimeMs < s.queryStartedUptimeMs)
    throw new Error('Invalid file-descriptor source, identity or timing');
  if (s.availability === 'available'
    ? !descriptorInteger(s.count) || !descriptorInteger(s.excludedCollectorDescriptor) || s.reason !== null
    : s.availability === 'error'
      ? s.count !== null || s.excludedCollectorDescriptor !== null || typeof s.reason !== 'string' || !s.reason.trim()
      : true) throw new Error('Invalid file-descriptor availability');
  return s;
}

// This is a gauge: zero and decreases are valid; no interval baseline is needed.
export class FileDescriptorTracker {
  private previous: FileDescriptorSample | null = null;
  reset() { this.previous = null; }
  record(value: unknown): FileDescriptorSample {
    try {
      const sample = validateFileDescriptorSample(value), previous = this.previous;
      if (previous && previous.observationId === sample.observationId && previous.processId === sample.processId &&
          (sample.sequence <= previous.sequence || sample.queryStartedUptimeMs < previous.queryFinishedUptimeMs))
        throw new Error('File-descriptor samples are out of order');
      this.previous = sample;
      return sample;
    } catch (error) { this.reset(); throw error; }
  }
}

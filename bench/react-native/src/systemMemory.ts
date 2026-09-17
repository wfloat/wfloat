export type SystemLowMemoryState = {
  value: boolean | null;
  source: "ActivityManager.getMemoryInfo().lowMemory";
  error: string | null;
};

export type SystemLowMemoryThreshold = {
  bytes: number | null;
  rawBytes: string;
  source: "ActivityManager.getMemoryInfo().threshold";
  error: string | null;
};

export type SystemMemorySample = {
  availableBytes: number | null;
  rawAvailableBytes: string;
  error: string | null;
  source: "ActivityManager.getMemoryInfo().availMem";
  scope: "system";
  platform: "android";
  osVersion: string;
  apiLevel: number;
  clockSource: "SystemClock.elapsedRealtimeNanos";
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  sampledAtMs: number;
  processId: number;
  sequence: number;
  // Additive fields: validate separately so an old or malformed field does not hide availability.
  lowMemory?: SystemLowMemoryState;
  lowMemoryThreshold?: SystemLowMemoryThreshold;
};

export function validateSystemMemorySample(value: unknown): SystemMemorySample {
  if (!value || typeof value !== "object") throw new Error("Missing system memory sample");
  const s = value as SystemMemorySample;
  if (s.platform !== "android" || s.scope !== "system" ||
      s.source !== "ActivityManager.getMemoryInfo().availMem" ||
      s.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      ![s.processId, s.sequence, s.apiLevel].every(n => Number.isSafeInteger(n) && n > 0) ||
      typeof s.osVersion !== "string" || !s.osVersion.trim() ||
      ![s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.sampledAtMs].every(Number.isFinite) ||
      s.queryStartedUptimeMs < 0 || s.queryFinishedUptimeMs < s.queryStartedUptimeMs || s.sampledAtMs <= 0 ||
      typeof s.rawAvailableBytes !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(s.rawAvailableBytes))
    throw new Error("Invalid system memory source, scope, identity or query bounds");
  const raw = BigInt(s.rawAvailableBytes);
  if (raw.toString() !== s.rawAvailableBytes || raw < -9223372036854775808n || raw > 9223372036854775807n)
    throw new Error("Invalid native available-memory integer");
  const exact = raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER);
  if (exact ? !Number.isSafeInteger(s.availableBytes) || s.availableBytes! < 0 ||
      BigInt(s.availableBytes!) !== raw || s.error !== null
    : s.availableBytes !== null || typeof s.error !== "string" || !s.error.trim())
    throw new Error("Invalid system memory value or unavailable state");
  return s;
}

export function validateSystemLowMemory(sample: SystemMemorySample): SystemLowMemoryState {
  validateSystemMemorySample(sample);
  const state = sample.lowMemory;
  if (!state || state.source !== "ActivityManager.getMemoryInfo().lowMemory" ||
      (state.value === null ? typeof state.error !== "string" || !state.error.trim()
        : typeof state.value !== "boolean" || state.error !== null))
    throw new Error("Invalid or missing Android low-memory state. Rebuild the app if needed.");
  return state;
}

export function validateSystemLowMemoryThreshold(sample: SystemMemorySample): SystemLowMemoryThreshold {
  validateSystemMemorySample(sample);
  const threshold = sample.lowMemoryThreshold;
  if (!threshold || threshold.source !== "ActivityManager.getMemoryInfo().threshold" ||
      typeof threshold.rawBytes !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(threshold.rawBytes))
    throw new Error("Invalid or missing Android low-memory threshold. Rebuild the app if needed.");
  const raw = BigInt(threshold.rawBytes);
  if (raw.toString() !== threshold.rawBytes || raw < -9223372036854775808n || raw > 9223372036854775807n)
    throw new Error("Invalid native low-memory threshold integer");
  const exact = raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER);
  if (exact ? !Number.isSafeInteger(threshold.bytes) || threshold.bytes! < 0 ||
      BigInt(threshold.bytes!) !== raw || threshold.error !== null
    : threshold.bytes !== null || typeof threshold.error !== "string" || !threshold.error.trim())
    throw new Error("Invalid low-memory threshold value or unavailable state");
  // Do not derive or validate lowMemory by comparing available bytes to this threshold.
  return threshold;
}

// A system-wide gauge. Falling values and zero are legitimate observations.
export class SystemMemoryTracker {
  private previous: SystemMemorySample | null = null;
  readonly samples: SystemMemorySample[] = [];
  reset() { this.previous = null; }
  record(value: unknown): SystemMemorySample {
    try {
      const current = validateSystemMemorySample(value), previous = this.previous;
      if (previous && previous.processId === current.processId && previous.osVersion === current.osVersion &&
          previous.apiLevel === current.apiLevel &&
          (current.sequence <= previous.sequence || current.queryStartedUptimeMs < previous.queryFinishedUptimeMs))
        throw new Error("System memory samples are out of order");
      this.previous = current;
      this.samples.push(current);
      if (this.samples.length > 120) this.samples.shift();
      return current;
    } catch (error) { this.reset(); throw error; }
  }
}

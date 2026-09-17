const sources = {
  android: { source: "/proc/self/status:Threads", clock: "SystemClock.elapsedRealtimeNanos" },
  ios: { source: "task_threads(mach_task_self()):count", clock: "NSProcessInfo.systemUptime" },
} as const;

export type ThreadSample = {
  platform: "android" | "ios";
  threadCount: number;
  source: string;
  clockSource: string;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  sampledAtMs: number;
  processId: number;
  sequence: number;
  osVersion: string;
  apiLevel?: number;
};

export function validateThreadSample(value: unknown): ThreadSample {
  if (!value || typeof value !== "object") throw new Error("Missing thread sample");
  const s = value as ThreadSample;
  if (s.platform !== "android" && s.platform !== "ios") throw new Error("Unknown thread-count platform");
  const definition = sources[s.platform];
  if (![s.threadCount, s.processId, s.sequence].every(n => Number.isSafeInteger(n) && n > 0) ||
      s.threadCount > 4294967295 ||
      ![s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.sampledAtMs].every(Number.isFinite) ||
      s.queryStartedUptimeMs < 0 || s.queryFinishedUptimeMs < s.queryStartedUptimeMs || s.sampledAtMs <= 0 ||
      s.source !== definition.source || s.clockSource !== definition.clock ||
      typeof s.osVersion !== "string" || !s.osVersion ||
      (s.platform === "android" && (!Number.isSafeInteger(s.apiLevel) || s.apiLevel! <= 0)))
    throw new Error("Invalid thread-count sample");
  return s;
}

// A gauge: a lower count is valid, and one fresh sample is sufficient.
export class ThreadTracker {
  private previous: ThreadSample | null = null;
  readonly samples: ThreadSample[] = [];
  reset() { this.previous = null; }
  record(value: unknown): ThreadSample {
    try {
      const current = validateThreadSample(value), previous = this.previous;
      if (previous && previous.processId === current.processId && previous.platform === current.platform &&
          previous.osVersion === current.osVersion &&
          (current.sequence <= previous.sequence || current.queryStartedUptimeMs < previous.queryFinishedUptimeMs))
        throw new Error("Thread-count samples are out of order");
      this.previous = current;
      this.samples.push(current);
      if (this.samples.length > 120) this.samples.shift();
      return current;
    } catch (error) { this.reset(); throw error; }
  }
}

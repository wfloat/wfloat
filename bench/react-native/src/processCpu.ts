export type ProcessCpuSample = {
  userCpuTimeUs: number;
  systemCpuTimeUs: number;
  cpuTimeMs: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  monotonicMs: number;
  clockSource: string;
  sampledAtMs: number;
  processId: number;
  sequence: number;
  source: string;
  platform: "android" | "ios";
  osVersion: string;
  apiLevel?: number;
};

export type ProcessCpuUsage = {
  previous: ProcessCpuSample;
  current: ProcessCpuSample;
  userDeltaMs: number;
  systemDeltaMs: number;
  cpuDeltaMs: number;
  elapsedMs: number;
  userPercent: number;
  systemPercent: number;
  percent: number;
};

export function validateProcessCpuSample(value: unknown): ProcessCpuSample {
  if (!value || typeof value !== "object") throw new Error("Invalid process CPU sample");
  const s = value as ProcessCpuSample;
  const clocks = { android: "SystemClock.elapsedRealtimeNanos", ios: "NSProcessInfo.systemUptime" };
  if ((s.platform !== "android" && s.platform !== "ios") ||
      ![s.userCpuTimeUs, s.systemCpuTimeUs].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isSafeInteger(s.userCpuTimeUs + s.systemCpuTimeUs) ||
      s.cpuTimeMs !== (s.userCpuTimeUs + s.systemCpuTimeUs) / 1000 ||
      ![s.cpuTimeMs, s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.monotonicMs, s.sampledAtMs].every(Number.isFinite) ||
      s.queryStartedUptimeMs < 0 || s.queryFinishedUptimeMs < s.queryStartedUptimeMs || s.sampledAtMs <= 0 ||
      s.monotonicMs !== s.queryStartedUptimeMs + (s.queryFinishedUptimeMs - s.queryStartedUptimeMs) / 2 ||
      ![s.processId, s.sequence].every(n => Number.isSafeInteger(n) && n > 0) ||
      s.source !== "getrusage(RUSAGE_SELF):ru_utime,ru_stime" || s.clockSource !== clocks[s.platform] ||
      typeof s.osVersion !== "string" || !s.osVersion ||
      (s.platform === "android" && (!Number.isSafeInteger(s.apiLevel) || s.apiLevel! <= 0)))
    throw new Error("Invalid process CPU sample");
  return s;
}

// All three percentages use the same two native samples and elapsed interval.
export class ProcessCpuTracker {
  private previous: ProcessCpuSample | null = null;
  readonly samples: ProcessCpuSample[] = [];
  resetWindow() { this.previous = null; }

  record(value: unknown): ProcessCpuUsage | null {
    try {
      const current = validateProcessCpuSample(value), previous = this.previous;
      let usage: ProcessCpuUsage | null = null;
      if (previous && previous.processId === current.processId && previous.source === current.source &&
          previous.platform === current.platform && previous.clockSource === current.clockSource &&
          previous.osVersion === current.osVersion && previous.apiLevel === current.apiLevel) {
        const elapsedMs = current.monotonicMs - previous.monotonicMs;
        const userDeltaUs = current.userCpuTimeUs - previous.userCpuTimeUs;
        const systemDeltaUs = current.systemCpuTimeUs - previous.systemCpuTimeUs;
        if (elapsedMs <= 0 || userDeltaUs < 0 || systemDeltaUs < 0 || current.sequence <= previous.sequence ||
            current.queryStartedUptimeMs < previous.queryFinishedUptimeMs)
          throw new Error("Process CPU counter or monotonic clock moved backwards, or samples are out of order");
        const userDeltaMs = userDeltaUs / 1000, systemDeltaMs = systemDeltaUs / 1000;
        const cpuDeltaMs = (userDeltaUs + systemDeltaUs) / 1000;
        usage = { previous, current, userDeltaMs, systemDeltaMs, cpuDeltaMs, elapsedMs,
          userPercent: 100 * userDeltaMs / elapsedMs, systemPercent: 100 * systemDeltaMs / elapsedMs,
          percent: 100 * cpuDeltaMs / elapsedMs };
      }
      this.previous = current;
      this.samples.push(current);
      if (this.samples.length > 120) this.samples.shift();
      return usage;
    } catch (error) { this.resetWindow(); throw error; }
  }
}

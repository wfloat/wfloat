export type ThreadCpuReading = {
  threadId: string;
  startTimeTicks: string | null;
  name: string | null;
  userTime: number;
  systemTime: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  runState?: number | string;
  priority?: number;
  nice?: number;
  affinity?: { available: boolean; cpuList: string | null; cpuCount: number | null; reason: string | null;
    queryStartedUptimeMs: number; queryFinishedUptimeMs: number };
  getterAffinity?: { available: boolean; cpuIds: number[] | null; reason: string | null;
    queryStartedUptimeMs: number; queryFinishedUptimeMs: number };
  contextSwitches?: { available: boolean; voluntaryCount: string | null; involuntaryCount: string | null; reason: string | null;
    queryStartedUptimeMs: number; queryFinishedUptimeMs: number };
  lastCpu?: number;
  policy?: number;
  rtPriority?: number;
};
export type ThreadCpuSample = {
  capture?: { state: string; path: string };
  platform: "android" | "ios";
  source: string;
  clockSource: string;
  counterUnit: "clock_ticks" | "microseconds";
  counterUnitsPerSecond: number;
  processId: number;
  sequence: number;
  osVersion: string;
  apiLevel?: number;
  sampledAtMs: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  enumeratedThreadCount: number;
  threads: ThreadCpuReading[];
  errors: { threadId: string | null; reason: string }[];
  getterAffinitySource?: string;
  getterAffinityUnit?: string;
  getterAffinityCapacity?: number;
  getterAffinityIdentityCheck?: string;
  contextSwitchesSource?: string;
  contextSwitchesUnit?: string;
  contextSwitchesEncoding?: string;
  contextSwitchesIdentityCheck?: string;
  affinitySource?: string;
  affinityUnit?: string;
  affinityIdentityCheck?: string;
  lastCpuSource?: string;
  lastCpuUnit?: string;
  schedulerSource?: string;
  policyUnit?: string;
  rtPriorityUnit?: string;
  prioritySource?: string;
  priorityUnit?: string;
  niceUnit?: string;
  runStateSource?: string;
  runStateEnvironment?: "simulator" | "device";
};
export type ThreadCpuUsage = {
  reading: ThreadCpuReading;
  percent: number | null;
  userDeltaMs: number | null;
  systemDeltaMs: number | null;
  elapsedMs: number | null;
  state: "measured" | "baseline" | "counter_reset";
};
const nonnegative = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const decimal = (s: unknown): s is string => typeof s === "string" && /^(0|[1-9][0-9]*)$/.test(s) &&
  s.length <= 20 && BigInt(s) <= 18446744073709551615n;
const key = (r: ThreadCpuReading) => `${r.threadId}:${r.startTimeTicks ?? ""}`;
const midpoint = (r: ThreadCpuReading) => r.queryStartedUptimeMs + (r.queryFinishedUptimeMs - r.queryStartedUptimeMs) / 2;

export function validateThreadCpuSample(value: unknown): ThreadCpuSample {
  if (!value || typeof value !== "object") throw new Error("Missing thread CPU sample");
  const s = value as ThreadCpuSample, android = s.platform === "android";
  if ((!android && s.platform !== "ios") ||
      s.source !== (android ? "/proc/self/task/*/stat:utime,stime,starttime" : "thread_info(THREAD_BASIC_INFO,THREAD_IDENTIFIER_INFO)") ||
      s.clockSource !== (android ? "SystemClock.elapsedRealtimeNanos" : "NSProcessInfo.systemUptime") ||
      s.counterUnit !== (android ? "clock_ticks" : "microseconds") ||
      !nonnegative(s.counterUnitsPerSecond) || s.counterUnitsPerSecond === 0 ||
      (!android && s.counterUnitsPerSecond !== 1000000) ||
      ![s.processId, s.sequence, s.enumeratedThreadCount].every(n => nonnegative(n) && n > 0) ||
      s.enumeratedThreadCount > 1024 || typeof s.osVersion !== "string" || !s.osVersion ||
      (android && (!nonnegative(s.apiLevel) || s.apiLevel === 0)) ||
      ![s.sampledAtMs, s.queryStartedUptimeMs, s.queryFinishedUptimeMs].every(n => Number.isFinite(n) && n >= 0) ||
      s.queryFinishedUptimeMs < s.queryStartedUptimeMs ||
      !Array.isArray(s.threads) || !Array.isArray(s.errors) ||
      s.threads.length + s.errors.length !== s.enumeratedThreadCount)
    throw new Error("Invalid thread CPU sample");
  const seen = new Set<string>();
  let lastFinished = s.queryStartedUptimeMs;
  for (const t of s.threads) {
    if (!t || !decimal(t.threadId) || t.threadId === "0" || seen.has(t.threadId) ||
        (android ? !decimal(t.startTimeTicks) : t.startTimeTicks !== null) ||
        (t.name !== null && typeof t.name !== "string") ||
        ![t.userTime, t.systemTime, t.userTime + t.systemTime].every(nonnegative) ||
        ![t.queryStartedUptimeMs, t.queryFinishedUptimeMs].every(Number.isFinite) ||
        t.queryStartedUptimeMs < lastFinished || t.queryFinishedUptimeMs < t.queryStartedUptimeMs ||
        t.queryFinishedUptimeMs > s.queryFinishedUptimeMs)
      throw new Error("Invalid thread CPU reading or identity");
    seen.add(t.threadId); lastFinished = t.queryFinishedUptimeMs;
  }
  for (const e of s.errors) {
    if (!e || typeof e.reason !== "string" || !e.reason ||
        (e.threadId !== null && (!decimal(e.threadId) || e.threadId === "0" || seen.has(e.threadId))))
      throw new Error("Invalid unreadable-thread record");
    if (e.threadId !== null) seen.add(e.threadId);
  }
  return s;
}

// Keep only the immediately preceding scan. Missing/new/reused threads need a new baseline.
export class ThreadCpuTracker {
  private previous: ThreadCpuSample | null = null;
  reset() { this.previous = null; }
  record(value: unknown): { sample: ThreadCpuSample; rows: ThreadCpuUsage[] } {
    try {
      const sample = validateThreadCpuSample(value), previous = this.previous;
      const compatible = previous && previous.processId === sample.processId && previous.platform === sample.platform &&
        previous.osVersion === sample.osVersion && previous.apiLevel === sample.apiLevel &&
        previous.counterUnitsPerSecond === sample.counterUnitsPerSecond;
      if (compatible && (sample.sequence <= previous.sequence || sample.queryStartedUptimeMs < previous.queryFinishedUptimeMs))
        throw new Error("Thread CPU scans are out of order");
      const old = new Map(compatible ? previous.threads.map(t => [key(t), t]) : []);
      const rows: ThreadCpuUsage[] = sample.threads.map(reading => {
        const prior = old.get(key(reading));
        const result: ThreadCpuUsage = { reading, percent: null, userDeltaMs: null, systemDeltaMs: null, elapsedMs: null, state: "baseline" };
        if (!prior) return result;
        const user = reading.userTime - prior.userTime, system = reading.systemTime - prior.systemTime;
        const elapsed = midpoint(reading) - midpoint(prior);
        if (user < 0 || system < 0 || elapsed <= 0) return { ...result, state: "counter_reset" };
        const userDeltaMs = user * 1000 / sample.counterUnitsPerSecond;
        const systemDeltaMs = system * 1000 / sample.counterUnitsPerSecond;
        return { reading, userDeltaMs, systemDeltaMs, elapsedMs: elapsed,
          percent: 100 * (userDeltaMs + systemDeltaMs) / elapsed, state: "measured" };
      });
      rows.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || a.reading.threadId.localeCompare(b.reading.threadId));
      this.previous = sample;
      return { sample, rows };
    } catch (error) { this.reset(); throw error; }
  }
}

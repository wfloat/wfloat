export type ContextSwitchSample = {
  platform: "android" | "ios";
  source: string;
  clockSource: string;
  counters: { total: number; voluntary?: number; involuntary?: number };
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  sampledAtMs: number;
  processId: number;
  sequence: number;
  osVersion: string;
  apiLevel?: number;
  probe: { running: boolean; wakes: number; elapsedMs: number; runSequence: number };
};
export type ContextSwitchRate = {
  previous: ContextSwitchSample; current: ContextSwitchSample;
  elapsedMs: number; delta: number; perSecond: number;
  voluntaryDelta?: number; involuntaryDelta?: number;
  voluntaryPerSecond?: number; involuntaryPerSecond?: number;
};
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
export function validateContextSwitchSample(value: unknown): ContextSwitchSample {
  if (!value || typeof value !== "object") throw new Error("Invalid context-switch sample");
  const s = value as ContextSwitchSample, c = s.counters, p = s.probe;
  const android = s.platform === "android", ios = s.platform === "ios";
  if ((!android && !ios) || !c || !count(c.total) ||
      s.source !== (android ? "getrusage(RUSAGE_SELF):ru_nvcsw,ru_nivcsw" : "task_info(TASK_EVENTS_INFO):csw") ||
      s.clockSource !== (android ? "SystemClock.elapsedRealtimeNanos" : "NSProcessInfo.systemUptime") ||
      ![s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.sampledAtMs].every(Number.isFinite) ||
      s.queryStartedUptimeMs < 0 || s.queryFinishedUptimeMs < s.queryStartedUptimeMs || s.sampledAtMs <= 0 ||
      !count(s.processId) || s.processId === 0 || !count(s.sequence) || s.sequence === 0 ||
      typeof s.osVersion !== "string" || !s.osVersion ||
      !p || typeof p.running !== "boolean" || !count(p.wakes) || !count(p.runSequence) ||
      !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0 ||
      (android && (!count(c.voluntary) || !count(c.involuntary) ||
        c.total !== c.voluntary + c.involuntary || !count(s.apiLevel) || s.apiLevel === 0)) ||
      (ios && (c.total >= 2147483647 || c.voluntary !== undefined || c.involuntary !== undefined)))
    throw new Error("Invalid or exhausted context-switch sample");
  return s;
}
const midpoint = (s: ContextSwitchSample) => s.queryStartedUptimeMs + (s.queryFinishedUptimeMs - s.queryStartedUptimeMs) / 2;
export class ContextSwitchTracker {
  private previous: ContextSwitchSample | null = null;
  readonly samples: ContextSwitchSample[] = [];
  resetWindow() { this.previous = null; }
  record(value: unknown): { sample: ContextSwitchSample; rate: ContextSwitchRate | null } {
    try {
      const s = validateContextSwitchSample(value), p = this.previous;
      let rate: ContextSwitchRate | null = null;
      if (p && p.processId === s.processId && p.platform === s.platform && p.source === s.source &&
          p.clockSource === s.clockSource && p.osVersion === s.osVersion && p.apiLevel === s.apiLevel) {
        const elapsedMs = midpoint(s) - midpoint(p), delta = s.counters.total - p.counters.total;
        if (s.sequence <= p.sequence || s.queryStartedUptimeMs < p.queryFinishedUptimeMs || elapsedMs <= 0 || delta < 0)
          throw new Error("Context-switch counters moved backwards or samples are out of order");
        rate = { previous: p, current: s, elapsedMs, delta, perSecond: 1000 * delta / elapsedMs };
        if (s.platform === "android") {
          const voluntaryDelta = s.counters.voluntary! - p.counters.voluntary!;
          const involuntaryDelta = s.counters.involuntary! - p.counters.involuntary!;
          if (voluntaryDelta < 0 || involuntaryDelta < 0) throw new Error("Context-switch component moved backwards");
          Object.assign(rate, { voluntaryDelta, involuntaryDelta,
            voluntaryPerSecond: 1000 * voluntaryDelta / elapsedMs,
            involuntaryPerSecond: 1000 * involuntaryDelta / elapsedMs });
        }
      }
      this.previous = s; this.samples.push(s);
      if (this.samples.length > 120) this.samples.shift();
      return { sample: s, rate };
    } catch (error) { this.resetWindow(); throw error; }
  }
}

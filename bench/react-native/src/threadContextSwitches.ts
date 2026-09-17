import { validateThreadCpuSample } from "./threadCpu";

const counter = (s: unknown): s is string => typeof s === "string" && s.length <= 20 &&
  /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) <= 18446744073709551615n;
export function validateAndroidThreadContextSwitches(value: unknown) {
  const s = validateThreadCpuSample(value);
  if (s.platform !== "android" || s.contextSwitchesSource !== "/proc/self/task/*/status:voluntary_ctxt_switches,nonvoluntary_ctxt_switches" ||
      s.contextSwitchesUnit !== "switches" || s.contextSwitchesEncoding !== "uint64_decimal_string" ||
      s.contextSwitchesIdentityCheck !== "stat_starttime_before_after")
    throw new Error("Thread context switches were not recorded by this build. Rebuild the app.");
  const threads = s.threads.map(t => {
    const c = t.contextSwitches;
    if (!c || typeof c.available !== "boolean" || !Number.isFinite(c.queryStartedUptimeMs) || !Number.isFinite(c.queryFinishedUptimeMs) ||
        c.queryStartedUptimeMs < t.queryFinishedUptimeMs || c.queryFinishedUptimeMs < c.queryStartedUptimeMs ||
        c.queryFinishedUptimeMs > s.queryFinishedUptimeMs) throw new Error("Invalid thread context-switch reading or timing.");
    if (c.available) {
      if (c.reason !== null || !counter(c.voluntaryCount) || !counter(c.involuntaryCount)) throw new Error("Invalid thread context-switch counters.");
    } else if (c.voluntaryCount !== null || c.involuntaryCount !== null || typeof c.reason !== "string" || !c.reason.length || c.reason.length > 128) {
      throw new Error("Invalid unavailable thread context-switch reading.");
    }
    return { ...c, threadId: t.threadId, startTimeTicks: t.startTimeTicks };
  });
  const observed = threads.filter(t => t.available).length;
  return { threads, observed, unavailable: s.enumeratedThreadCount - observed, enumerated: s.enumeratedThreadCount };
}

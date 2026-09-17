import { validateThreadCpuSample } from "./threadCpu";

export function countAffinityCpus(list: string): number {
  if (typeof list !== "string" || !list.length || list.length > 1024) throw new Error("Invalid CPU list.");
  let previous = -1, count = 0;
  for (const item of list.split(",")) {
    if (!/^(0|[1-9][0-9]*)(-(0|[1-9][0-9]*))?$/.test(item)) throw new Error("Invalid CPU range.");
    const parts = item.split("-").map(Number), first = parts[0], last = parts[1] ?? first;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first <= previous || last < first || last > 2147483647)
      throw new Error("Invalid CPU range order.");
    count += last - first + 1; previous = last;
  }
  return count;
}
export function validateAndroidThreadAffinity(value: unknown) {
  const s = validateThreadCpuSample(value);
  if (s.platform !== "android" || s.affinitySource !== "/proc/self/task/*/status:Cpus_allowed_list" ||
      s.affinityUnit !== "logical_cpu_list" || s.affinityIdentityCheck !== "stat_starttime_before_after")
    throw new Error("Thread CPU allowance was not recorded by this build. Rebuild the app.");
  const threads = s.threads.map(t => {
    const a = t.affinity;
    if (!a || typeof a.available !== "boolean" || !Number.isFinite(a.queryStartedUptimeMs) || !Number.isFinite(a.queryFinishedUptimeMs) ||
        a.queryStartedUptimeMs < t.queryFinishedUptimeMs || a.queryFinishedUptimeMs < a.queryStartedUptimeMs ||
        a.queryFinishedUptimeMs > s.queryFinishedUptimeMs) throw new Error("Invalid affinity reading or timing.");
    if (a.available) {
      if (a.reason !== null || typeof a.cpuList !== "string" || a.cpuCount !== countAffinityCpus(a.cpuList)) throw new Error("Invalid affinity list/count.");
    } else if (a.cpuList !== null || a.cpuCount !== null || typeof a.reason !== "string" || !a.reason.length || a.reason.length > 128) {
      throw new Error("Invalid unavailable affinity reading.");
    }
    return { ...a, threadId: t.threadId, startTimeTicks: t.startTimeTicks };
  });
  const observed = threads.filter(t => t.available).length;
  return { threads, observed, unavailable: s.enumeratedThreadCount - observed, enumerated: s.enumeratedThreadCount };
}

import { validateThreadCpuSample } from "./threadCpu";

export function formatGetterCpuIds(ids: number[]): string {
  if (!Array.isArray(ids) || ids.length > 1024 || !ids.every((v, i) => Number.isInteger(v) && v >= 0 && v < 1024 && (i === 0 || v > ids[i - 1])))
    throw new Error("Invalid getter CPU IDs.");
  const ranges: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const first = ids[i];
    while (i + 1 < ids.length && ids[i + 1] === ids[i] + 1) i++;
    ranges.push(first === ids[i] ? `${first}` : `${first}-${ids[i]}`);
  }
  return ranges.join(",");
}
export function validateAndroidThreadGetterAffinity(value: unknown) {
  const s = validateThreadCpuSample(value);
  if (s.platform !== "android" || s.getterAffinitySource !== "sched_getaffinity(tid)" ||
      s.getterAffinityUnit !== "logical_cpu_ids" || s.getterAffinityCapacity !== 1024 ||
      s.getterAffinityIdentityCheck !== "stat_starttime_before_after")
    throw new Error("Getter CPU allowance was not recorded by this build. Rebuild the app.");
  const threads = s.threads.map(t => {
    const a = t.getterAffinity;
    if (!a || typeof a.available !== "boolean" || !Number.isFinite(a.queryStartedUptimeMs) || !Number.isFinite(a.queryFinishedUptimeMs) ||
        a.queryStartedUptimeMs < t.queryFinishedUptimeMs || a.queryFinishedUptimeMs < a.queryStartedUptimeMs ||
        a.queryFinishedUptimeMs > s.queryFinishedUptimeMs) throw new Error("Invalid getter affinity reading or timing.");
    let cpuList: string | null = null, cpuCount: number | null = null;
    if (a.available) {
      if (a.reason !== null || !Array.isArray(a.cpuIds)) throw new Error("Invalid getter affinity reading.");
      cpuList = formatGetterCpuIds(a.cpuIds); cpuCount = a.cpuIds.length;
    } else if (a.cpuIds !== null || typeof a.reason !== "string" || !a.reason.length || a.reason.length > 128) {
      throw new Error("Invalid unavailable getter affinity reading.");
    }
    return { ...a, cpuList, cpuCount, threadId: t.threadId, startTimeTicks: t.startTimeTicks };
  });
  const observed = threads.filter(t => t.available).length;
  return { threads, observed, unavailable: s.enumeratedThreadCount - observed, enumerated: s.enumeratedThreadCount };
}

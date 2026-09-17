import { pageFaultDefinitions, type PageFaultKind } from "./pageFaults.ts";

type FaultSnapshot = {
  counters: Record<string, number>;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
};
export type FileFaultPass = {
  name: "first_read" | "reread";
  before: FaultSnapshot;
  after: FaultSnapshot;
  readStartedUptimeMs: number;
  readFinishedUptimeMs: number;
  residentPagesBefore: number;
  residencyErrno: number;
  touchedPages: number;
  checksum: number;
};
export type FileFaultResult = {
  status: "completed" | "cancelled" | "deadline" | "failed";
  stage: string;
  error: string;
  kind: PageFaultKind;
  source: string;
  processId: number;
  runSequence: number;
  fileBytes: number;
  pageSizeBytes: number;
  startedAtMs: number;
  startedUptimeMs: number;
  finishedUptimeMs: number;
  budgetMs: number;
  clockSource: string;
  cacheOperation: string;
  cacheResult: number;
  randomAdviceResult: number;
  passes: FileFaultPass[];
};
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function validateFileFaultResult(value: unknown, kind: PageFaultKind): FileFaultResult {
  if (!value || typeof value !== "object") throw new Error("Missing file-probe result");
  const result = value as FileFaultResult;
  if (result.kind !== kind || !["completed", "cancelled", "deadline", "failed"].includes(result.status) ||
      ![result.processId, result.runSequence].every(n => integer(n) && n > 0) ||
      result.fileBytes !== 32 * 1024 * 1024 || !integer(result.pageSizeBytes) ||
      result.budgetMs !== 30000 || result.clockSource !== "CLOCK_MONOTONIC" ||
      ![result.startedAtMs, result.startedUptimeMs, result.finishedUptimeMs].every(Number.isFinite) ||
      result.startedUptimeMs < 0 || result.finishedUptimeMs < result.startedUptimeMs ||
      ![result.source, result.stage].every(s => typeof s === "string" && s.length > 0) ||
      typeof result.error !== "string" || typeof result.cacheOperation !== "string" ||
      ![result.cacheResult, result.randomAdviceResult].every(n => Number.isSafeInteger(n) && n >= -1) ||
      !Array.isArray(result.passes) || result.passes.length > 2)
    throw new Error("Invalid file-probe result");
  if ((result.status === "completed" && (result.passes.length !== 2 || result.error)) ||
      (result.passes.length && (!result.pageSizeBytes || result.fileBytes % result.pageSizeBytes !== 0)))
    throw new Error("Incomplete file-probe result");
  const pages = result.fileBytes / result.pageSizeBytes;
  for (const [index, pass] of result.passes.entries()) {
    const times = [result.startedUptimeMs, pass?.before?.queryStartedUptimeMs, pass?.before?.queryFinishedUptimeMs,
      pass?.readStartedUptimeMs, pass?.readFinishedUptimeMs, pass?.after?.queryStartedUptimeMs,
      pass?.after?.queryFinishedUptimeMs, result.finishedUptimeMs];
    if (!pass || pass.name !== (index === 0 ? "first_read" : "reread") ||
        !times.every(Number.isFinite) || times.some((n, i) => i > 0 && n < times[i - 1]) ||
        !integer(pass.touchedPages) || pass.touchedPages !== pages || !integer(pass.checksum) ||
        !Number.isSafeInteger(pass.residentPagesBefore) || pass.residentPagesBefore < -1 || pass.residentPagesBefore > pages ||
        !integer(pass.residencyErrno) || (pass.residentPagesBefore === -1) !== (pass.residencyErrno > 0))
      throw new Error("Invalid file-probe pass");
    for (const snapshot of [pass.before, pass.after]) {
      if (!snapshot.counters || Object.keys(snapshot.counters).length !== 2 ||
          !pageFaultDefinitions[kind].every(({ key }) => integer(snapshot.counters[key]) &&
            (kind !== "ios_vm_events" || snapshot.counters[key] < 2147483647)))
        throw new Error("Invalid file-probe counters");
    }
    if (pageFaultDefinitions[kind].some(({ key }) => pass.after.counters[key] < pass.before.counters[key]))
      throw new Error("File-probe counter decreased");
  }
  if (result.passes.length === 2 && (result.passes[0].checksum !== result.passes[1].checksum ||
      result.passes[1].before.queryStartedUptimeMs < result.passes[0].after.queryFinishedUptimeMs))
    throw new Error("File-probe passes are inconsistent");
  return result;
}

export function fileFaultDeltas(pass: FileFaultPass): Record<string, number> {
  return Object.fromEntries(Object.keys(pass.before.counters).map(key =>
    [key, pass.after.counters[key] - pass.before.counters[key]]));
}

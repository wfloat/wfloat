export const storageIoSources = {
  android: "getrusage(RUSAGE_SELF):ru_inblock,ru_oublock",
  ios: "proc_pid_rusage(RUSAGE_INFO_V2):ri_diskio_bytesread,ri_diskio_byteswritten",
} as const;
export type StorageIoSample = {
  platform: keyof typeof storageIoSources;
  source: string;
  counters: Record<string, number>;
  clockSource: "CLOCK_MONOTONIC";
  processId: number;
  sequence: number;
  osVersion: string;
  apiLevel?: number;
  kernelRelease: string;
  accountingUnitBytes?: number;
  procIo?: { source: string; counters: Record<string, number> | null; errno: number; error: string | null };
  sampledAtMs: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
};
export type StorageIoWindow = { elapsedMs: number; deltas: Record<string, number>; perSecond: Record<string, number> };
export type StorageIoReading = { sample: StorageIoSample; window: StorageIoWindow | null };
export const ioKeys = (platform: string) => platform === "android"
  ? ["readBytes", "writeBytes", "readBlocks", "writeBlocks"]
  : ["readBytes", "writeBytes"];
export function validateStorageIoSample(value: unknown): StorageIoSample {
  if (!value || typeof value !== "object") throw new Error("Missing storage I/O reading");
  const row = value as StorageIoSample;
  if ((row.platform !== "android" && row.platform !== "ios") || row.source !== storageIoSources[row.platform] ||
      row.clockSource !== "CLOCK_MONOTONIC" || typeof row.osVersion !== "string" || !row.osVersion.trim() ||
      typeof row.kernelRelease !== "string" || !row.kernelRelease.trim() ||
      ![row.processId, row.sequence].every(n => Number.isSafeInteger(n) && n > 0) ||
      (row.platform === "android" && (!Number.isSafeInteger(row.apiLevel) || row.apiLevel! <= 0)) ||
      ![row.sampledAtMs, row.queryStartedUptimeMs, row.queryFinishedUptimeMs].every(n => Number.isFinite(n) && n >= 0) ||
      row.queryFinishedUptimeMs < row.queryStartedUptimeMs ||
      !row.counters || typeof row.counters !== "object" || Array.isArray(row.counters) ||
      Object.keys(row.counters).length !== ioKeys(row.platform).length ||
      !ioKeys(row.platform).every(key => Object.hasOwn(row.counters, key) && Number.isSafeInteger(row.counters[key]) && row.counters[key] >= 0))
    throw new Error("Invalid storage I/O counters, source or sample identity");
  if (row.platform === "android" && (row.accountingUnitBytes !== 512 || row.counters.readBytes !== row.counters.readBlocks * 512 ||
      row.counters.writeBytes !== row.counters.writeBlocks * 512)) throw new Error("Invalid Android I/O block conversion");
  return row;
}
const midpoint = (row: StorageIoSample) => row.queryStartedUptimeMs + (row.queryFinishedUptimeMs - row.queryStartedUptimeMs) / 2;
export class StorageIoTracker {
  private previous: StorageIoSample | null = null;
  resetWindow() { this.previous = null; }
  record(value: unknown): StorageIoReading {
    try {
      const sample = validateStorageIoSample(value), previous = this.previous;
      let window: StorageIoWindow | null = null;
      if (previous && previous.processId === sample.processId && previous.platform === sample.platform &&
          previous.osVersion === sample.osVersion && previous.apiLevel === sample.apiLevel && previous.kernelRelease === sample.kernelRelease) {
        const elapsedMs = midpoint(sample) - midpoint(previous);
        if (sample.sequence <= previous.sequence || sample.queryStartedUptimeMs < previous.queryFinishedUptimeMs || elapsedMs <= 0)
          throw new Error("Storage I/O samples are out of order");
        const deltas: Record<string, number> = {}, perSecond: Record<string, number> = {};
        for (const key of ioKeys(sample.platform)) {
          const delta = sample.counters[key] - previous.counters[key];
          if (delta < 0) throw new Error("Storage I/O counter decreased; starting a new interval");
          deltas[key] = delta; perSecond[key] = delta * 1000 / elapsedMs;
          if (!Number.isFinite(perSecond[key])) throw new Error("Invalid storage I/O rate");
        }
        window = { elapsedMs, deltas, perSecond };
      }
      this.previous = sample;
      return { sample, window };
    } catch (error) { this.resetWindow(); throw error; }
  }
}
// Extra procfs counters have different access and child-process scope. Their
// absence must not invalidate the main getrusage readings.
export function validProcIo(sample: StorageIoSample): Record<string, number> | null {
  const extra = sample.procIo;
  const keys = ["readBytes", "writeBytes", "cancelledWriteBytes", "logicalReadBytes", "logicalWriteBytes", "readCalls", "writeCalls"];
  if (!extra || extra.source !== "/proc/self/io" || extra.errno !== 0 || extra.error !== null || !extra.counters ||
      Object.keys(extra.counters).length !== keys.length || !keys.every(key =>
        Object.hasOwn(extra.counters!, key) && Number.isSafeInteger(extra.counters![key]) && extra.counters![key] >= 0)) return null;
  return extra.counters;
}
export type StorageIoCheck = {
  status: "completed"; runSequence: number; fileBytes: number; readPasses: number;
  cachePolicy: string; sync: string; osVersion: string; apiLevel?: number;
  cacheControl?: { operation: string; errno: number } | null;
  snapshots: StorageIoSample[];
};
export function validateStorageIoCheck(value: unknown, platform: string): { result: StorageIoCheck; windows: StorageIoWindow[] } {
  const result = value as StorageIoCheck;
  if (!result || result.status !== "completed" || !Number.isSafeInteger(result.runSequence) || result.runSequence <= 0 ||
      result.fileBytes !== 32 * 1024 * 1024 || result.readPasses !== 2 || !["buffered_no_eviction", "file_cache_control"].includes(result.cachePolicy) ||
      result.sync !== "fsync" || !Array.isArray(result.snapshots) || result.snapshots.length !== 4)
    throw new Error("Invalid storage check result");
  if (result.cachePolicy === "file_cache_control") {
    const expected = platform === "ios" ? "fcntl(F_NOCACHE,1) before write and both reads"
      : "posix_fadvise(POSIX_FADV_DONTNEED) after fsync, before first read";
    if (!result.cacheControl || result.cacheControl.operation !== expected ||
        !Number.isSafeInteger(result.cacheControl.errno) || result.cacheControl.errno < 0)
      throw new Error("Invalid storage cache-control provenance");
  } else if (result.cacheControl != null) throw new Error("Unexpected cache control on a buffered check");
  const tracker = new StorageIoTracker(), windows: StorageIoWindow[] = [];
  for (const [index, snapshot] of result.snapshots.entries()) {
    if (snapshot.platform !== platform || snapshot.osVersion !== result.osVersion || snapshot.apiLevel !== result.apiLevel)
      throw new Error("Storage check identity changed");
    const reading = tracker.record(snapshot);
    if (index > 0) {
      if (!reading.window) throw new Error("Storage check process changed");
      windows.push(reading.window);
    }
  }
  return { result, windows };
}

import { validateMemorySample, type MemorySample, type DecompressionCounter } from "./memory.ts";

export const DECOMPRESSION_LIMIT = 2147483647;
export type DecompressionRate = { delta: number; elapsedMs: number; perSecond: number };

export function validateDecompressions(sample: MemorySample): DecompressionCounter {
  validateMemorySample(sample);
  const c = sample.decompressions;
  if (!c || sample.platform !== "ios" || c.source !== "task_info(TASK_VM_INFO).decompressions" ||
      c.scope !== "calling_process" || c.unit !== "events" || c.aggregation !== "cumulative" ||
      !["simulator", "device"].includes(c.environment) || typeof c.saturated !== "boolean" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid decompression source, scope or sample identity");
  if (c.count === null) {
    if (typeof c.error !== "string" || !c.error.trim() || c.saturated ||
        (c.rawCount !== null && (typeof c.rawCount !== "string" || !/^-[1-9][0-9]*$/.test(c.rawCount) ||
          BigInt(c.rawCount) < -2147483648n)))
      throw new Error("Invalid unavailable decompression counter");
  } else if (!Number.isSafeInteger(c.count) || c.count < 0 || c.count > DECOMPRESSION_LIMIT ||
      c.rawCount !== String(c.count) || c.error !== null || c.saturated !== (c.count === DECOMPRESSION_LIMIT)) {
    throw new Error("Invalid or inexact decompression counter");
  }
  return c;
}

export class DecompressionTracker {
  private previous: MemorySample | null = null;
  resetWindow() { this.previous = null; }
  record(sample: MemorySample): { counter: DecompressionCounter; rate: DecompressionRate | null } {
    try {
      const counter = validateDecompressions(sample), previous = this.previous;
      let rate: DecompressionRate | null = null;
      if (counter.count === null) { this.resetWindow(); return { counter, rate }; }
      if (previous && previous.processId === sample.processId && previous.osVersion === sample.osVersion &&
          previous.decompressions!.environment === counter.environment) {
        const delta = counter.count - previous.decompressions!.count!;
        const midpoint = (s: MemorySample) => s.queryStartedUptimeMs! +
          (s.queryFinishedUptimeMs! - s.queryStartedUptimeMs!) / 2;
        const elapsedMs = midpoint(sample) - midpoint(previous);
        if (sample.sequence! <= previous.sequence! || sample.queryStartedUptimeMs! < previous.queryFinishedUptimeMs! ||
            elapsedMs <= 0 || delta < 0)
          throw new Error("Decompression counter decreased or samples are out of order");
        // Missing samples and saturation cannot become a misleading zero rate.
        if (sample.sequence === previous.sequence! + 1 && !counter.saturated && !previous.decompressions!.saturated)
          rate = { delta, elapsedMs, perSecond: delta * 1000 / elapsedMs };
      }
      this.previous = sample;
      return { counter, rate };
    } catch (error) { this.resetWindow(); throw error; }
  }
}

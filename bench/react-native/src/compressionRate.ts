import { validateCumulativeCompressedMemory, type MemorySample } from "./memory.ts";

// A display freshness policy for the nominal two-second poll, not an OS limit.
export const MAX_COMPRESSION_INTERVAL_MS = 5000;
export type CompressionRate = {
  deltaBytes: number;
  rawDeltaBytes: string;
  elapsedMs: number;
  bytesPerSecond: number;
  fromSequence: number;
  toSequence: number;
  processId: number;
  fromUptimeMs: number;
  toUptimeMs: number;
  source: "task_info(TASK_VM_INFO).compressed_lifetime";
  derivation: "ledger_credit_delta_over_query_midpoint_elapsed";
};
export type CompressionRateReading = {
  status: "measured" | "baseline" | "unavailable";
  rate: CompressionRate | null;
  reason: string | null;
};
type Baseline = {
  processId: number; sequence: number; osVersion: string; environment: string;
  start: number; finish: number; midpoint: number; total: bigint;
};

export class CompressionRateTracker {
  private previous: Baseline | null = null;
  resetWindow() { this.previous = null; }
  record(sample: MemorySample): CompressionRateReading {
    try {
      const counter = validateCumulativeCompressedMemory(sample);
      if (counter.rawBytes === null) {
        this.resetWindow();
        return { status: "unavailable", rate: null, reason: counter.error };
      }
      // Validate the raw total first, then subtract exactly. Even when a lifetime
      // total cannot fit in a JS number, its interval delta can still be exact.
      const current: Baseline = {
        processId: sample.processId!, sequence: sample.sequence!, osVersion: sample.osVersion!,
        environment: counter.environment, start: sample.queryStartedUptimeMs!, finish: sample.queryFinishedUptimeMs!,
        midpoint: sample.queryStartedUptimeMs! + (sample.queryFinishedUptimeMs! - sample.queryStartedUptimeMs!) / 2,
        total: BigInt(counter.rawBytes),
      };
      const previous = this.previous;
      this.previous = current;
      const baseline = (reason: string): CompressionRateReading => ({ status: "baseline", rate: null, reason });
      if (!previous) return baseline("Waiting for two valid consecutive readings.");
      if (previous.processId !== current.processId || previous.osVersion !== current.osVersion || previous.environment !== current.environment)
        return baseline("Process or environment changed; starting a fresh interval.");
      const delta = current.total - previous.total;
      const elapsedMs = current.midpoint - previous.midpoint;
      if (current.sequence <= previous.sequence || current.start < previous.finish || elapsedMs <= 0 || delta < 0)
        throw new Error("Compression counter decreased or samples are out of order; starting a fresh interval.");
      if (current.sequence !== previous.sequence + 1)
        return baseline("Missing samples; starting a fresh interval.");
      if (elapsedMs > MAX_COMPRESSION_INTERVAL_MS)
        return baseline("Sampling gap exceeded 5 seconds; starting a fresh interval.");
      if (delta > BigInt(Number.MAX_SAFE_INTEGER))
        return { status: "unavailable", rate: null, reason: "Interval byte change exceeds exact numeric range." };
      const deltaBytes = Number(delta), bytesPerSecond = deltaBytes / elapsedMs * 1000;
      if (!Number.isFinite(bytesPerSecond)) throw new Error("Invalid compression accounting rate.");
      return { status: "measured", reason: null, rate: {
        deltaBytes, rawDeltaBytes: delta.toString(), elapsedMs, bytesPerSecond,
        fromSequence: previous.sequence, toSequence: current.sequence, processId: current.processId,
        fromUptimeMs: previous.midpoint, toUptimeMs: current.midpoint,
        source: "task_info(TASK_VM_INFO).compressed_lifetime",
        derivation: "ledger_credit_delta_over_query_midpoint_elapsed",
      } };
    } catch (error) { this.resetWindow(); throw error; }
  }
}

export type MemoryWarningReceipt = {
  sequence: number;
  receivedAtMs: number;
  receivedUptimeMs: number;
  applicationState: "active" | "inactive" | "background" | "unknown";
};

export type MemoryWarningSnapshot = {
  source: "UIApplication.didReceiveMemoryWarningNotification";
  scope: "warnings_delivered_to_app";
  platform: "ios";
  osVersion: string;
  environment: "simulator" | "device";
  clockSource: "NSProcessInfo.systemUptime";
  processId: number;
  observationId: string;
  observationStartedAtMs: number;
  observationStartedUptimeMs: number;
  warningCount: number;
  lastWarning: MemoryWarningReceipt | null;
  snapshotAtMs: number;
  snapshotUptimeMs: number;
};

export function validateMemoryWarningSnapshot(value: unknown): MemoryWarningSnapshot {
  if (!value || typeof value !== "object") throw new Error("Missing native memory-warning record");
  const s = value as MemoryWarningSnapshot;
  if (s.source !== "UIApplication.didReceiveMemoryWarningNotification" ||
      s.scope !== "warnings_delivered_to_app" || s.platform !== "ios" ||
      s.clockSource !== "NSProcessInfo.systemUptime" || !["simulator", "device"].includes(s.environment) ||
      typeof s.osVersion !== "string" || !s.osVersion.trim() ||
      typeof s.observationId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s.observationId) ||
      !Number.isSafeInteger(s.processId) || s.processId <= 0 ||
      !Number.isSafeInteger(s.warningCount) || s.warningCount < 0 ||
      ![s.observationStartedAtMs, s.snapshotAtMs].every(n => Number.isFinite(n) && n > 0) ||
      ![s.observationStartedUptimeMs, s.snapshotUptimeMs].every(n => Number.isFinite(n) && n >= 0) ||
      s.snapshotUptimeMs < s.observationStartedUptimeMs)
    throw new Error("Invalid native memory-warning source, identity, count or observation time");
  const last = s.lastWarning;
  if (s.warningCount === 0 ? last !== null : !last || last.sequence !== s.warningCount ||
      !Number.isFinite(last.receivedAtMs) || last.receivedAtMs <= 0 ||
      !Number.isFinite(last.receivedUptimeMs) || last.receivedUptimeMs < s.observationStartedUptimeMs ||
      last.receivedUptimeMs > s.snapshotUptimeMs ||
      !["active", "inactive", "background", "unknown"].includes(last.applicationState))
    throw new Error("Invalid native memory-warning receipt or count mismatch");
  return s;
}

// Subscribing before reading closes the startup gap. A delayed read must not
// overwrite a newer event; native snapshots are cumulative, so skipped events
// can be reconciled without inventing receipt times for the missing history.
export class MemoryWarningTracker {
  private previous: MemoryWarningSnapshot | null = null;
  record(value: unknown): MemoryWarningSnapshot {
    const next = validateMemoryWarningSnapshot(value), previous = this.previous;
    if (previous && next.observationId === previous.observationId) {
      if (next.processId !== previous.processId || next.osVersion !== previous.osVersion ||
          next.environment !== previous.environment ||
          next.observationStartedAtMs !== previous.observationStartedAtMs ||
          next.observationStartedUptimeMs !== previous.observationStartedUptimeMs)
        throw new Error("Memory-warning observation identity changed");
      if (next.snapshotUptimeMs < previous.snapshotUptimeMs) {
        if (next.warningCount > previous.warningCount) throw new Error("Memory-warning count has inconsistent timing");
        return previous;
      }
      if (next.warningCount < previous.warningCount ||
          (next.warningCount === previous.warningCount &&
            (next.lastWarning?.receivedAtMs !== previous.lastWarning?.receivedAtMs ||
             next.lastWarning?.receivedUptimeMs !== previous.lastWarning?.receivedUptimeMs ||
             next.lastWarning?.applicationState !== previous.lastWarning?.applicationState)) ||
          (next.warningCount > previous.warningCount && previous.lastWarning &&
            next.lastWarning!.receivedUptimeMs < previous.lastWarning.receivedUptimeMs))
        throw new Error("Memory-warning count or receipt regressed");
    }
    this.previous = next;
    return next;
  }
}

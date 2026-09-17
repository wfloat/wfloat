export type EnergyMonitor = {
  id: string; index: number; name: string; typeRaw: number; type: "rail" | "consumer" | "unknown";
  availability: "available" | "unavailable" | "error"; reason: string | null;
  rawEnergyUws: string | null; rawSnapshotUptimeMs: string | null;
  joules: number | null; snapshotAgeAtReadMs: number | null; callbackUptimeMs: number;
};
export type EnergyRead = {
  source: "SystemHealthManager.powerMonitors";
  status: "ready" | "empty" | "unsupported" | "error"; reason: string | null;
  queryStage: string; inventoryId: string; pid: number; uid: number; sequence: number;
  apiLevel: number; fingerprint: string; scope: "device_subsystems";
  finePermissionGranted: boolean; collectionMode: "manual" | "comparison";
  queryStartedUptimeMs: number; queryFinishedUptimeMs: number; queryDurationMs: number;
  recordedAtMs: number; monitorCount: number; monitors: EnergyMonitor[];
};
const nonnegative = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const integer = (x: unknown): x is number => nonnegative(x) && Number.isSafeInteger(x);
const rawLong = (x: unknown): x is string => {
  if (typeof x !== "string" || !/^(0|-?[1-9]\d*)$/.test(x)) return false;
  const magnitude = x.replace(/^-/, ""), max = x.startsWith("-") ? "9223372036854775808" : "9223372036854775807";
  return magnitude.length < max.length || (magnitude.length === max.length && magnitude <= max);
};
export function validateEnergyRead(s: EnergyRead): EnergyRead {
  if (!s || s.source !== "SystemHealthManager.powerMonitors" || s.scope !== "device_subsystems" ||
      !["manual", "comparison"].includes(s.collectionMode) || typeof s.finePermissionGranted !== "boolean" ||
      ![s.pid, s.uid, s.sequence, s.apiLevel].every(x => integer(x) && x > 0) ||
      ![s.inventoryId, s.fingerprint, s.queryStage].every(x => typeof x === "string" && x.length > 0) ||
      !["ready", "empty", "unsupported", "error"].includes(s.status) ||
      ![s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.queryDurationMs, s.recordedAtMs].every(nonnegative) ||
      s.queryFinishedUptimeMs < s.queryStartedUptimeMs ||
      Math.abs(s.queryDurationMs - (s.queryFinishedUptimeMs - s.queryStartedUptimeMs)) > 0.01 ||
      !Array.isArray(s.monitors) || !integer(s.monitorCount) || s.monitorCount !== s.monitors.length)
    throw new Error("Invalid native energy response.");
  if (s.status === "ready" ? s.reason !== null || !s.monitorCount || s.apiLevel < 35 || s.queryStage !== "readings"
      : s.monitorCount !== 0 || typeof s.reason !== "string" || !s.reason)
    throw new Error("Invalid energy availability result.");
  if (s.status === "unsupported" && (s.reason !== "requires_api_35" || s.apiLevel >= 35))
    throw new Error("Invalid energy OS requirement.");
  if (s.status === "empty" && (s.reason !== "no_exposed_monitors" || s.apiLevel < 35))
    throw new Error("Invalid empty energy inventory.");
  for (const [i, m] of s.monitors.entries()) {
    if (!m || m.index !== i || m.id !== `${s.inventoryId}:${i}` || typeof m.name !== "string" ||
        !Number.isSafeInteger(m.typeRaw) || m.type !== (m.typeRaw === 1 ? "rail" : m.typeRaw === 0 ? "consumer" : "unknown") ||
        !["available", "unavailable", "error"].includes(m.availability) || !integer(m.callbackUptimeMs) ||
        m.callbackUptimeMs > s.queryFinishedUptimeMs || m.callbackUptimeMs + 1 < s.queryStartedUptimeMs ||
        (m.rawEnergyUws !== null && !rawLong(m.rawEnergyUws)) ||
        (m.rawSnapshotUptimeMs !== null && !rawLong(m.rawSnapshotUptimeMs)))
      throw new Error("Invalid energy monitor identity or timing.");
    if (m.availability === "available") {
      const raw = Number(m.rawEnergyUws), snapshot = Number(m.rawSnapshotUptimeMs);
      if (m.rawEnergyUws === null || m.rawSnapshotUptimeMs === null || !nonnegative(raw) || !integer(snapshot) ||
          snapshot > m.callbackUptimeMs || !nonnegative(m.joules) || m.reason !== null ||
          Math.abs(m.joules - raw / 1e6) > Math.max(1e-12, m.joules * Number.EPSILON * 2) ||
          m.snapshotAgeAtReadMs !== m.callbackUptimeMs - snapshot)
        throw new Error("Invalid energy value or snapshot age.");
    } else if (m.joules !== null || m.snapshotAgeAtReadMs !== null || typeof m.reason !== "string" || !m.reason ||
        (m.availability === "unavailable" && (m.rawEnergyUws !== "-1" || m.reason !== "energy_unavailable")))
      throw new Error("Invalid missing energy value.");
  }
  return s;
}
export function energyReadNote(s: EnergyRead): string {
  if (s.status === "unsupported") return "Requires Android 15 (API 35) or later.";
  if (s.status === "empty") return "Android exposed no energy monitors. Hardware may be absent or the service may be disabled.";
  if (s.reason === "callback_timeout") return "Android did not finish the request within 10 seconds. You can retry.";
  if (s.status === "error") return `Read failed at ${s.queryStage} (${s.reason}).`;
  return `${s.monitors.filter(m => m.availability === "available").length} readings from ${s.monitorCount} exposed monitors.`;
}

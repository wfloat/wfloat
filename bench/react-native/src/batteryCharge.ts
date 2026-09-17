import type { BatteryCurrentSample } from "./batteryCurrent";

export type BatteryChargeSample = Omit<BatteryCurrentSample, "source" | "rawMicroamps" | "milliamps"> & {
  source: "BatteryManager.getLongProperty(BATTERY_PROPERTY_CHARGE_COUNTER)";
  scope: "battery_remaining_charge";
  platform: "android";
  clockSource: "SystemClock.elapsedRealtimeNanos";
  environment: "emulator" | "device";
  environmentDetection: "build_heuristic";
  collectionMode: "passive" | "refresh_probe";
  refreshProbeId: number | null;
  rawMicroampHours: number | null;
  milliampHours: number | null;
};

export function validateBatteryCharge(sample: BatteryChargeSample): BatteryChargeSample {
  if (!sample || sample.source !== "BatteryManager.getLongProperty(BATTERY_PROPERTY_CHARGE_COUNTER)" ||
      sample.scope !== "battery_remaining_charge" || sample.platform !== "android" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      !["emulator", "device"].includes(sample.environment) || sample.environmentDetection !== "build_heuristic" ||
      !["available", "unavailable", "error"].includes(sample.availability) ||
      ![sample.readStartedAtMs, sample.readCompletedAtMs, sample.readStartedUptimeMs,
        sample.readCompletedUptimeMs, sample.queryDurationMs].every(v => Number.isFinite(v) && v >= 0) ||
      sample.readCompletedUptimeMs < sample.readStartedUptimeMs ||
      Math.abs(sample.queryDurationMs - (sample.readCompletedUptimeMs - sample.readStartedUptimeMs)) > 0.001 ||
      sample.sensorSampledAtMs !== null ||
      ![sample.pid, sample.sequence, sample.apiLevel].every(v => Number.isSafeInteger(v) && v > 0) ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      (sample.collectionMode !== "passive" && sample.collectionMode !== "refresh_probe") ||
      (sample.collectionMode === "passive" ? sample.refreshProbeId !== null :
        !Number.isSafeInteger(sample.refreshProbeId) || sample.refreshProbeId! < 1) ||
      (sample.rawPropertyValue !== null && (typeof sample.rawPropertyValue !== "string" || !/^-?\d+$/.test(sample.rawPropertyValue))))
    throw new Error("Invalid native battery-charge sample.");
  const raw = sample.rawPropertyValue === null ? null : BigInt(sample.rawPropertyValue);
  if (raw !== null && (raw < -9223372036854775808n || raw > 9223372036854775807n))
    throw new Error("Invalid native battery-charge integer.");
  const int = raw !== null && raw >= -2147483648n && raw <= 2147483647n ? Number(raw) : null;
  if (sample.rawMicroampHours !== int)
    throw new Error("Battery-charge raw values disagree.");
  const context = sample.batteryContext;
  if (context !== null && (!context ||
      !["sticky_cache", "broadcast"].includes(context.receiptKind) ||
      ![context.receivedAtMs, context.receivedUptimeMs].every(v => Number.isFinite(v) && v >= 0) ||
      context.receivedUptimeMs > sample.readStartedUptimeMs ||
      !Number.isSafeInteger(context.sequence) || context.sequence < 1 ||
      (context.batteryPresent !== null && typeof context.batteryPresent !== "boolean") ||
      ![context.statusRaw, context.pluggedRaw].every(v => v === null || Number.isSafeInteger(v))))
    throw new Error("Invalid battery-charge context.");
  const reason = sample.reason;
  const expected = reason?.startsWith("query_failed:") ? reason : raw === null ? "battery_service_missing"
    : raw === -9223372036854775808n ? "unsupported_or_error"
    : raw < 0n || raw > 2147483647n ? "invalid_charge_range"
    : context?.batteryPresent === false ? "battery_absent" : null;
  const availability = expected === null ? "available" : expected.startsWith("query_failed:") ||
    expected === "invalid_charge_range" ? "error" : "unavailable";
  if (reason !== expected || sample.availability !== availability ||
      sample.milliampHours !== (expected === null ? int! / 1000 : null))
    throw new Error("Invalid battery-charge availability or conversion.");
  return sample;
}

export function batteryChargeValue(sample: BatteryChargeSample): string {
  if (sample.availability !== "available") return sample.availability === "error" ? "Read failed" : "Unavailable";
  return `${sample.milliampHours!.toFixed(3)} mAh`;
}

export function batteryChargeNote(sample: BatteryChargeSample): string {
  if (sample.reason === "unsupported_or_error") return "Android did not provide remaining charge: unsupported or a service error.";
  if (sample.reason === "battery_absent") return "Charge unavailable because the latest OS report says no battery is present.";
  if (sample.availability !== "available") return `Remaining charge could not be read (${sample.reason}).`;
  return sample.rawMicroampHours === 0
    ? "Android reports zero remaining charge. This does not establish a physically empty battery."
    : "Fuel-gauge estimate of charge remaining in the whole battery.";
}

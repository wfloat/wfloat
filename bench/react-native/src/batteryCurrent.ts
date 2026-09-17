import type { BatteryTemperatureReport } from "./batteryTemperature";

export type BatteryCurrentSample = {
  source: "BatteryManager.getLongProperty(BATTERY_PROPERTY_CURRENT_NOW)";
  availability: "available" | "unavailable" | "error";
  reason: string | null;
  rawPropertyValue: string | null;
  /** Unmodified integer, named for Android's declared unit; OEM firmware may report different units. */
  rawMicroamps: number | null;
  milliamps: number | null;
  readStartedAtMs: number;
  readCompletedAtMs: number;
  readStartedUptimeMs: number;
  readCompletedUptimeMs: number;
  queryDurationMs: number;
  sensorSampledAtMs: null;
  batteryContext: Pick<BatteryTemperatureReport, "batteryPresent" | "statusRaw" | "pluggedRaw" |
    "receiptKind" | "receivedAtMs" | "receivedUptimeMs" | "sequence"> | null;
  pid: number;
  sequence: number;
  apiLevel: number;
  osVersion: string;
};

export function validateBatteryCurrent(sample: BatteryCurrentSample): BatteryCurrentSample {
  if (!sample || sample.source !== "BatteryManager.getLongProperty(BATTERY_PROPERTY_CURRENT_NOW)" ||
      !["available", "unavailable", "error"].includes(sample.availability) ||
      ![sample.readStartedAtMs, sample.readCompletedAtMs, sample.readStartedUptimeMs,
        sample.readCompletedUptimeMs, sample.queryDurationMs].every(v => Number.isFinite(v) && v >= 0) ||
      sample.readCompletedUptimeMs < sample.readStartedUptimeMs ||
      Math.abs(sample.queryDurationMs - (sample.readCompletedUptimeMs - sample.readStartedUptimeMs)) > 0.001 ||
      sample.sensorSampledAtMs !== null ||
      ![sample.pid, sample.sequence, sample.apiLevel].every(v => Number.isSafeInteger(v) && v > 0) ||
      typeof sample.osVersion !== "string" ||
      (sample.rawPropertyValue !== null && (typeof sample.rawPropertyValue !== "string" || !/^-?\d+$/.test(sample.rawPropertyValue))) ||
      (sample.rawMicroamps !== null && (!Number.isSafeInteger(sample.rawMicroamps) ||
        sample.rawMicroamps < -2147483648 || sample.rawMicroamps > 2147483647 ||
        sample.rawPropertyValue !== String(sample.rawMicroamps))))
    throw new Error("Invalid native battery-current sample.");
  const context = sample.batteryContext;
  if (context !== null && (!context ||
      !["sticky_cache", "broadcast"].includes(context.receiptKind) ||
      ![context.receivedAtMs, context.receivedUptimeMs].every(v => Number.isFinite(v) && v >= 0) ||
      context.receivedUptimeMs > sample.readStartedUptimeMs ||
      !Number.isSafeInteger(context.sequence) || context.sequence < 1 ||
      (context.batteryPresent !== null && typeof context.batteryPresent !== "boolean") ||
      ![context.statusRaw, context.pluggedRaw].every(v => v === null || Number.isSafeInteger(v))))
    throw new Error("Invalid battery-current context.");
  if (sample.availability === "available") {
    if (sample.rawMicroamps === null || sample.reason !== null || context?.batteryPresent === false ||
        sample.milliamps !== sample.rawMicroamps / 1000)
      throw new Error("Invalid battery-current conversion.");
  } else if (sample.milliamps !== null || !sample.reason) {
    throw new Error("Missing battery-current failure details.");
  }
  return sample;
}

export function batteryCurrentValue(sample: BatteryCurrentSample): string {
  if (sample.availability !== "available") return sample.availability === "error" ? "Read failed" : "Unavailable";
  const value = sample.milliamps!;
  return `${value > 0 ? "+" : ""}${value.toFixed(3)} mA`;
}

export function batteryCurrentNote(sample: BatteryCurrentSample): string {
  if (sample.reason === "unsupported_or_error") return "Android did not provide current: unsupported or a service error.";
  if (sample.reason === "battery_absent") return "Current unavailable because the latest OS report says no battery is present.";
  if (sample.availability !== "available") return `Current could not be read (${sample.reason}).`;
  return sample.milliamps! > 0 ? "Net current entering the battery."
    : sample.milliamps! < 0 ? "Net current leaving the battery." : "Android reports zero net battery current.";
}

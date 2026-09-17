import type { BatteryTemperatureReport } from "./batteryTemperature";

export type BatteryVoltageReport = Pick<BatteryTemperatureReport,
  "batteryPresent" | "statusRaw" | "pluggedRaw" | "receiptKind" | "receivedAtMs" |
  "receivedUptimeMs" | "sensorSampledAtMs" | "pid" | "sequence" | "apiLevel" | "osVersion"> & {
  source: "ACTION_BATTERY_CHANGED/EXTRA_VOLTAGE";
  availability: "available" | "unavailable" | "error";
  reason: string | null;
  rawMillivolts: number | null;
  volts: number | null;
};

export function validateBatteryVoltage(report: BatteryVoltageReport): BatteryVoltageReport {
  if (!report || report.source !== "ACTION_BATTERY_CHANGED/EXTRA_VOLTAGE" ||
      !["available", "unavailable", "error"].includes(report.availability) ||
      !["sticky_cache", "broadcast"].includes(report.receiptKind) ||
      ![report.receivedAtMs, report.receivedUptimeMs].every(v => Number.isFinite(v) && v >= 0) ||
      report.sensorSampledAtMs !== null ||
      ![report.pid, report.sequence, report.apiLevel].every(v => Number.isSafeInteger(v) && v > 0) ||
      typeof report.osVersion !== "string" ||
      ![report.rawMillivolts, report.statusRaw, report.pluggedRaw].every(v => v === null || Number.isSafeInteger(v)) ||
      (report.rawMillivolts !== null && (report.rawMillivolts < -2147483648 || report.rawMillivolts > 2147483647)) ||
      (report.batteryPresent !== null && typeof report.batteryPresent !== "boolean"))
    throw new Error("Invalid native battery-voltage report.");
  if (report.availability === "available") {
    if (report.rawMillivolts === null || report.rawMillivolts <= 0 || report.reason !== null ||
        report.batteryPresent === false || report.volts !== report.rawMillivolts / 1000)
      throw new Error("Invalid battery-voltage conversion.");
  } else if (report.volts !== null || !report.reason) {
    throw new Error("Missing battery-voltage failure details.");
  }
  return report;
}

export function batteryVoltageValue(report: BatteryVoltageReport): string {
  return report.availability === "available" ? `${report.volts!.toFixed(3)} V`
    : report.availability === "error" ? "Read failed" : "Unavailable";
}

export function batteryVoltageReceiptAgeMs(report: BatteryVoltageReport, readUptimeMs: number): number {
  if (!Number.isFinite(readUptimeMs) || readUptimeMs < report.receivedUptimeMs)
    throw new Error("Invalid native battery clock. Rebuild the app.");
  return readUptimeMs - report.receivedUptimeMs;
}

export function formatBatteryReceiptAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 1) return "less than 1s ago";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function batteryVoltageNote(report: BatteryVoltageReport): string {
  switch (report.reason) {
    case null: return "Battery voltage. Charger voltage is a separate measurement.";
    case "battery_absent": return "Voltage unavailable because Android reports no battery.";
    case "voltage_missing": return "Android’s battery report contains no voltage.";
    case "zero_voltage": return "Android reports 0 mV; no usable positive battery voltage is available.";
    case "negative_voltage": return "Android reported an invalid negative battery voltage.";
    default: return `Battery voltage could not be read (${report.reason}).`;
  }
}

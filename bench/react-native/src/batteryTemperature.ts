export type BatteryTemperatureReport = {
  source: "ACTION_BATTERY_CHANGED/EXTRA_TEMPERATURE";
  availability: "available" | "unavailable" | "error";
  reason: string | null;
  rawTenthsCelsius: number | null;
  celsius: number | null;
  batteryPresent: boolean | null;
  statusRaw: number | null;
  pluggedRaw: number | null;
  receiptKind: "sticky_cache" | "broadcast";
  receivedAtMs: number;
  receivedUptimeMs: number;
  sensorSampledAtMs: null;
  pid: number;
  sequence: number;
  apiLevel: number;
  osVersion: string;
};

export function validateBatteryReport(report: BatteryTemperatureReport): BatteryTemperatureReport {
  const integerOrNull = (value: unknown) => value === null || Number.isSafeInteger(value);
  if (!report || report.source !== "ACTION_BATTERY_CHANGED/EXTRA_TEMPERATURE" ||
      !["available", "unavailable", "error"].includes(report.availability) ||
      !["sticky_cache", "broadcast"].includes(report.receiptKind) ||
      ![report.receivedAtMs, report.receivedUptimeMs].every(value => Number.isFinite(value) && value >= 0) ||
      report.sensorSampledAtMs !== null || !Number.isSafeInteger(report.sequence) || report.sequence < 1 ||
      !Number.isSafeInteger(report.pid) || report.pid < 1 ||
      ![report.rawTenthsCelsius, report.statusRaw, report.pluggedRaw].every(integerOrNull) ||
      (report.batteryPresent !== null && typeof report.batteryPresent !== "boolean")) {
    throw new Error("Invalid native battery report.");
  }
  if (report.availability === "available") {
    if (report.rawTenthsCelsius === null || report.batteryPresent === false || report.reason !== null ||
        typeof report.celsius !== "number" || !Number.isFinite(report.celsius) ||
        report.celsius !== report.rawTenthsCelsius / 10)
      throw new Error("Invalid battery-temperature conversion.");
  } else if (report.celsius !== null || !report.reason) {
    throw new Error("Missing battery-temperature failure details.");
  }
  return report;
}

export function batteryContext(report: Pick<BatteryTemperatureReport, "batteryPresent" | "statusRaw" | "pluggedRaw">): string {
  if (report.batteryPresent === false) return "Android reports no battery present.";
  const states: Record<number, string> = { 1: "Charging state unknown", 2: "Charging", 3: "Discharging", 4: "Not charging", 5: "Full" };
  const state = report.statusRaw === null ? "Charging state unavailable"
    : states[report.statusRaw] ?? `Charging state unknown (${report.statusRaw})`;
  const plugged = report.pluggedRaw === null ? "power connection unknown"
    : report.pluggedRaw === 0 ? "unplugged" : report.pluggedRaw > 0 ? "plugged in" : "power connection unknown";
  return `${state} · ${plugged}`;
}

export function batteryReceipt(report: Pick<BatteryTemperatureReport, "receiptKind" | "receivedAtMs">): string {
  const kind = report.receiptKind === "sticky_cache" ? "Cached OS report received" : "OS update received";
  return `${kind} at ${new Date(report.receivedAtMs).toLocaleTimeString([], { hour12: false })}. Sensor time unavailable.`;
}

export function batteryTemperatureNote(report: BatteryTemperatureReport): string {
  if (report.availability === "available") return "Battery temperature · CPU/GPU temperature is separate.";
  if (report.reason === "battery_absent") return "Temperature unavailable because Android reports no battery.";
  if (report.reason === "temperature_missing") return "Android's battery report contains no temperature.";
  return `Battery temperature could not be read (${report.reason}).`;
}

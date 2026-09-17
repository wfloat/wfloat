export type ThermalHeadroomSample = {
  availability: "available" | "unavailable" | "error";
  value: number | null;
  rawValue: string | null;
  reason: string | null;
  source: "PowerManager.getThermalHeadroom(0)";
  forecastSeconds: 0;
  apiLevel: number;
  osVersion: string;
  pid: number;
  sequence: number;
  sampledAtMs: number;
  uptimeMs: number;
  queryDurationMs: number;
  nextReadInMs: number;
  thermalStatusAtRead: number | null;
};

export function validateHeadroom(sample: ThermalHeadroomSample): ThermalHeadroomSample {
  if (!sample || sample.source !== "PowerManager.getThermalHeadroom(0)" || sample.forecastSeconds !== 0 ||
      !["available", "unavailable", "error"].includes(sample.availability) ||
      ![sample.sampledAtMs, sample.uptimeMs, sample.queryDurationMs, sample.nextReadInMs].every(
        value => Number.isFinite(value) && value >= 0) || sample.nextReadInMs > 10_000 ||
      !Number.isInteger(sample.sequence) || sample.sequence < 1) {
    throw new Error("Invalid native thermal-headroom sample.");
  }
  if (sample.availability === "available") {
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value) || sample.value < 0)
      throw new Error("Invalid thermal-headroom value.");
  } else if (sample.value !== null || !sample.reason) {
    throw new Error("Missing thermal-headroom failure details.");
  }
  return sample;
}

export function headroomNote(sample: ThermalHeadroomSample): string {
  if (sample.availability === "available") return "Current OS estimate · not °C or remaining performance.";
  if (sample.reason === "requires_api_30") return "Requires Android 11 (API 30) or later.";
  if (sample.reason === "not_reported")
    return "Android returned NaN: unsupported, not ready or rate limited. Retrying at the normal cadence.";
  return `Collector could not read headroom (${sample.reason}).`;
}

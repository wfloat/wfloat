export type CpuHeadroomSample = {
  source: "SystemHealthManager.getCpuHeadroom(CpuHeadroomParams)";
  scope: "calling_process_default";
  selectedTids: null;
  availability: "available" | "unavailable" | "unsupported" | "error";
  value: number | null;
  rawValue: string | null;
  reason: string | null;
  apiLevel: number;
  osVersion: string;
  pid: number;
  sequence: number;
  headroomQueried: boolean;
  queryStage: string;
  sampledAtMs: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  queryDurationMs: number;
  sensorSampledAtMs: null;
  minimumPollingIntervalMs: number | null;
  pollIntervalMs: number | null;
  nextReadInMs: number | null;
  calculationType: "average" | null;
  requestedWindowMs: number | null;
  supportedWindowMinMs: number | null;
  supportedWindowMaxMs: number | null;
};

const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const positiveInteger = (n: unknown): n is number => nonnegative(n) && Number.isSafeInteger(n) && n > 0;

export function validateCpuHeadroom(s: CpuHeadroomSample): CpuHeadroomSample {
  if (!s || s.source !== "SystemHealthManager.getCpuHeadroom(CpuHeadroomParams)" ||
      s.scope !== "calling_process_default" || s.selectedTids !== null || s.sensorSampledAtMs !== null ||
      !["available", "unavailable", "unsupported", "error"].includes(s.availability) ||
      ![s.pid, s.sequence, s.apiLevel].every(positiveInteger) || typeof s.osVersion !== "string" ||
      typeof s.headroomQueried !== "boolean" || typeof s.queryStage !== "string" ||
      ![s.sampledAtMs, s.queryStartedUptimeMs, s.queryFinishedUptimeMs, s.queryDurationMs].every(nonnegative) ||
      s.queryFinishedUptimeMs < s.queryStartedUptimeMs ||
      Math.abs(s.queryDurationMs - (s.queryFinishedUptimeMs - s.queryStartedUptimeMs)) > 0.01) {
    throw new Error("Invalid native CPU-headroom sample.");
  }
  if (s.minimumPollingIntervalMs !== null &&
      (!nonnegative(s.minimumPollingIntervalMs) || !Number.isSafeInteger(s.minimumPollingIntervalMs)))
    throw new Error("Invalid CPU-headroom minimum interval.");
  if (s.availability === "unsupported") {
    if (s.pollIntervalMs !== null || s.nextReadInMs !== null ||
        !["requires_api_36", "device_unsupported"].includes(s.reason ?? ""))
      throw new Error("Invalid CPU-headroom support result.");
  } else if (!positiveInteger(s.pollIntervalMs) || s.pollIntervalMs > 2147483647 ||
      s.pollIntervalMs < Math.max(2000, s.minimumPollingIntervalMs ?? 0) ||
      !nonnegative(s.nextReadInMs) || s.nextReadInMs > s.pollIntervalMs) {
    throw new Error("Invalid CPU-headroom polling cadence.");
  }
  if (s.headroomQueried && (s.apiLevel < 36 || s.queryStage !== "headroom" ||
      s.minimumPollingIntervalMs === null || s.calculationType !== "average" ||
      !positiveInteger(s.requestedWindowMs) || !positiveInteger(s.supportedWindowMinMs) ||
      !positiveInteger(s.supportedWindowMaxMs) || s.requestedWindowMs < s.supportedWindowMinMs ||
      s.requestedWindowMs > s.supportedWindowMaxMs))
    throw new Error("Missing CPU-headroom calculation context.");
  if (s.availability === "available") {
    if (!s.headroomQueried || !nonnegative(s.value) || s.value > 100 || s.reason !== null ||
        typeof s.rawValue !== "string" || !Number.isFinite(Number(s.rawValue)) ||
        Math.abs(Number(s.rawValue) - s.value) > 0.00001)
      throw new Error("Invalid CPU-headroom value.");
  } else if (s.value !== null || typeof s.reason !== "string" || !s.reason) {
    throw new Error("Missing CPU-headroom failure details.");
  }
  if (s.reason === "temporarily_unavailable" &&
      (s.availability !== "unavailable" || !s.headroomQueried || s.rawValue !== "NaN"))
    throw new Error("Invalid temporary CPU-headroom result.");
  return s;
}

export function cpuHeadroomNote(s: CpuHeadroomSample): string {
  if (s.availability === "available") return "OS capacity estimate for the calling process · not measured CPU utilization.";
  if (s.reason === "requires_api_36") return "Requires Android 16 (API 36) or later.";
  if (s.reason === "device_unsupported") return "Android reports that this device does not support CPU headroom. Polling stopped.";
  if (s.reason === "temporarily_unavailable")
    return "Android returned NaN: the estimate is not ready, workload may be insufficient, or the service could not supply it. Retrying.";
  if (s.reason === "service_missing") return "Android’s system health service is unavailable. Retrying.";
  return `CPU headroom query failed at ${s.queryStage} (${s.reason}).`;
}

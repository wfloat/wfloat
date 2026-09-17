export const pageFaultDefinitions = {
  android_minor_major: [
    { key: "minorFaults", label: "Minor faults", detail: "Resolved without I/O." },
    { key: "majorFaults", label: "Major faults", detail: "Required I/O to resolve." },
  ],
  ios_vm_events: [
    { key: "vmFaults", label: "VM faults", detail: "Mach page-fault events." },
    { key: "pageIns", label: "Page-ins", detail: "Mach page-in events; do not add to VM faults." },
  ],
} as const;

export type PageFaultKind = keyof typeof pageFaultDefinitions;
export type PageFaultSample = {
  kind: PageFaultKind;
  counters: Record<string, number>;
  source: string;
  pageSizeBytes: number;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  sampledAtMs: number;
  processId: number;
  sequence: number;
  osVersion: string;
};
export type PageFaultWindow = {
  previous: PageFaultSample;
  current: PageFaultSample;
  elapsedMs: number;
  deltas: Record<string, number>;
  perSecond: Record<string, number>;
};
export type PageFaultReading = { sample: PageFaultSample; window: PageFaultWindow | null };

function validateSample(value: unknown): PageFaultSample {
  if (!value || typeof value !== "object") throw new Error("Missing page-fault sample");
  const sample = value as PageFaultSample;
  if (sample.kind !== "android_minor_major" && sample.kind !== "ios_vm_events")
    throw new Error("Unknown page-fault counter definitions");
  if (!sample.counters || typeof sample.counters !== "object" || Array.isArray(sample.counters) ||
      Object.keys(sample.counters).length !== 2 ||
      !pageFaultDefinitions[sample.kind].every(({ key }) =>
        Object.hasOwn(sample.counters, key) && Number.isSafeInteger(sample.counters[key]) && sample.counters[key] >= 0) ||
      ![sample.pageSizeBytes, sample.processId, sample.sequence].every(n => Number.isSafeInteger(n) && n > 0) ||
      ![sample.queryStartedUptimeMs, sample.queryFinishedUptimeMs, sample.sampledAtMs].every(Number.isFinite) ||
      sample.queryStartedUptimeMs < 0 || sample.queryFinishedUptimeMs < sample.queryStartedUptimeMs ||
      typeof sample.source !== "string" || !sample.source || typeof sample.osVersion !== "string" || !sample.osVersion)
    throw new Error("Invalid page-fault sample");
  if (sample.kind === "ios_vm_events" && Object.values(sample.counters).some(n => n >= 2147483647))
    throw new Error("Mach event counter limit reached");
  return sample;
}

const midpoint = (sample: PageFaultSample) =>
  sample.queryStartedUptimeMs + (sample.queryFinishedUptimeMs - sample.queryStartedUptimeMs) / 2;

export class PageFaultTracker {
  private previous: PageFaultSample | null = null;
  readonly samples: PageFaultSample[] = [];
  resetWindow() { this.previous = null; }

  record(value: unknown): PageFaultReading {
    try {
      const current = validateSample(value);
      const previous = this.previous;
      let window: PageFaultWindow | null = null;
      if (previous && previous.processId === current.processId && previous.kind === current.kind &&
          previous.source === current.source && previous.pageSizeBytes === current.pageSizeBytes &&
          previous.osVersion === current.osVersion) {
        const elapsedMs = midpoint(current) - midpoint(previous);
        if (current.sequence <= previous.sequence || current.queryStartedUptimeMs < previous.queryFinishedUptimeMs || elapsedMs <= 0)
          throw new Error("Page-fault samples are out of order");
        const deltas: Record<string, number> = {};
        const perSecond: Record<string, number> = {};
        for (const { key } of pageFaultDefinitions[current.kind]) {
          const delta = current.counters[key] - previous.counters[key];
          if (delta < 0) throw new Error("Page-fault counter decreased; starting a new interval");
          deltas[key] = delta;
          perSecond[key] = delta * 1000 / elapsedMs;
        }
        window = { previous, current, elapsedMs, deltas, perSecond };
      }
      this.previous = current;
      this.samples.push(current);
      if (this.samples.length > 120) this.samples.shift();
      return { sample: current, window };
    } catch (error) {
      this.resetWindow();
      throw error;
    }
  }
}

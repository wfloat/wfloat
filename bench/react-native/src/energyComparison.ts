import { validateEnergyRead, type EnergyRead, type EnergyMonitor } from './powerMonitors.ts';

export const ENERGY_SETTLE_MS = 35000;
export const ENERGY_WINDOW_MS = 35000;
export type EnergyMode = 'idle' | 'cpu';
export type EnergyInterval = {
  id: string; name: string; type: EnergyMonitor['type'];
  reason: string | null; rawDeltaUws: string | null;
  elapsedMs: number | null; joules: number | null; averageWatts: number | null;
};
export type EnergyWindow = {
  mode: EnergyMode; start: EnergyRead; end: EnergyRead;
  eligibleAfterUptimeMs: number; intervals: EnergyInterval[];
};
export type EnergyComparisonRow = {
  id: string; name: string; type: EnergyMonitor['type'];
  idle: EnergyInterval; cpu: EnergyInterval; differenceWatts: number | null;
};

// Subtract nonnegative decimal counters before converting to floating point.
// Hermes in this prototype does not require BigInt; exact deltas remain strings.
function subtractCounter(end: string, start: string): string | null {
  if (end.length < start.length || (end.length === start.length && end < start)) return null;
  let borrow = 0, result = '';
  for (let i = end.length - 1, j = start.length - 1; i >= 0; i--, j--) {
    let digit = Number(end[i]) - Number(j >= 0 ? start[j] : '0') - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (borrow) digit += 10;
    result = digit + result;
  }
  return result.replace(/^0+(?=\d)/, '');
}

function sameInventory(start: EnergyRead, end: EnergyRead) {
  for (const key of ['inventoryId', 'pid', 'uid', 'apiLevel', 'fingerprint', 'finePermissionGranted', 'collectionMode', 'monitorCount'] as const)
    if (start[key] !== end[key]) throw new Error(`Energy identity/access changed: ${key}`);
  if (end.sequence <= start.sequence || end.queryStartedUptimeMs <= start.queryFinishedUptimeMs)
    throw new Error('Energy requests are out of order');
  if (start.monitors.some((m, i) => {
    const n = end.monitors[i]; return m.id !== n.id || m.name !== n.name || m.typeRaw !== n.typeRaw;
  })) throw new Error('Energy monitor inventory changed');
}

export function energyWindow(mode: EnergyMode, start: EnergyRead, end: EnergyRead, eligibleAfterUptimeMs: number): EnergyWindow {
  validateEnergyRead(start); validateEnergyRead(end);
  if (start.status !== 'ready' || end.status !== 'ready') throw new Error('Two available energy inventories are required');
  if (!Number.isFinite(eligibleAfterUptimeMs) || eligibleAfterUptimeMs < 0 ||
      eligibleAfterUptimeMs >= start.queryStartedUptimeMs) throw new Error('Invalid energy phase boundary');
  sameInventory(start, end);
  const intervals = start.monitors.map((a, i): EnergyInterval => {
    const b = end.monitors[i];
    const row: EnergyInterval = { id: a.id, name: a.name, type: a.type, reason: null,
      rawDeltaUws: null, elapsedMs: null, joules: null, averageWatts: null };
    const unavailable = (reason: string) => ({ ...row, reason });
    if (a.availability !== 'available' || b.availability !== 'available') return unavailable('Reading unavailable at an interval boundary');
    const t0 = Number(a.rawSnapshotUptimeMs), t1 = Number(b.rawSnapshotUptimeMs);
    if (t1 === t0) return unavailable('Cached snapshot: no new interval');
    if (t1 < t0) return unavailable('Snapshot clock moved backwards');
    if (t0 < eligibleAfterUptimeMs) return unavailable('Snapshot predates the settled phase');
    // Explicit experiment acceptance limits, not claims about the API cadence.
    if (t1 - t0 < 25000 || t1 - t0 > 50000) return unavailable('Snapshot interval outside the 25–50 s acceptance window');
    const delta = subtractCounter(b.rawEnergyUws!, a.rawEnergyUws!);
    if (delta === null) return unavailable('Energy decreased: noise or counter reset');
    const joules = Number(delta) / 1e6, elapsedMs = t1 - t0;
    return { ...row, rawDeltaUws: delta, joules, elapsedMs, averageWatts: joules / (elapsedMs / 1000) };
  });
  return { mode, start, end, eligibleAfterUptimeMs, intervals };
}

export function compareEnergyWindows(idle: EnergyWindow, cpu: EnergyWindow): EnergyComparisonRow[] {
  if (idle.mode !== 'idle' || cpu.mode !== 'cpu') throw new Error('Expected idle then CPU windows');
  sameInventory(idle.end, cpu.start);
  return idle.intervals.map((a, i) => {
    const b = cpu.intervals[i];
    if (!b || a.id !== b.id || a.name !== b.name || a.type !== b.type) throw new Error('Comparison inventory changed');
    return { id: a.id, name: a.name, type: a.type, idle: a, cpu: b,
      differenceWatts: a.averageWatts === null || b.averageWatts === null ? null : b.averageWatts - a.averageWatts };
  });
}

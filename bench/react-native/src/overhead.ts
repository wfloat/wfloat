import { ProcessCpuTracker, type ProcessCpuSample } from './processCpu.ts';
import type { MetricPublication } from './metricPublication';

export type OverheadMode = 'paused' | 'collect' | 'live';
export const OVERHEAD_ORDER: OverheadMode[] = ['paused', 'collect', 'live', 'collect', 'live', 'paused', 'live', 'paused', 'collect'];
export const WARMUP_MS = 10000;
export const WINDOW_MS = 20000;
export const MODE_LABELS = { paused: 'Dashboard paused', collect: 'Collect · display frozen', live: 'Collect · live display' };
export type OverheadWindow = {
  index: number; mode: OverheadMode; percent: number; userPercent: number; systemPercent: number;
  cpuDeltaMs: number; elapsedMs: number;
  start: ProcessCpuSample; end: ProcessCpuSample;
  activity: ReturnType<MetricPublication['snapshot']>;
};
export function overheadWindow(index: number, mode: OverheadMode, start: ProcessCpuSample, end: ProcessCpuSample,
  activity: OverheadWindow['activity']): OverheadWindow {
  if (OVERHEAD_ORDER[index] !== mode) throw new Error('Unexpected overhead phase');
  const tracker = new ProcessCpuTracker(); tracker.record(start);
  const usage = tracker.record(end);
  if (!usage || usage.elapsedMs < WINDOW_MS - 100 || usage.elapsedMs > WINDOW_MS + 5000)
    throw new Error('CPU interval was interrupted or delayed; repeat the check');
  if (mode === 'paused' && (activity.stateHookRenders || Object.keys(activity.stateWrites).length))
    throw new Error('Dashboard activity appeared during the paused phase');
  if (mode === 'paused' && end.sequence !== start.sequence + 1)
    throw new Error('Another CPU poll appeared during the paused phase');
  if (mode === 'collect' && activity.stateHookRenders)
    throw new Error('Metric display rendered during the frozen phase');
  // CPU headroom can stop after an unsupported result or have a device interval
  // longer than this window. Its writes still enter the audit when they occur.
  const expected = ['App', 'CpuUsageCard', 'ThreadCountCard', 'ThreadCpuCard', 'ContextSwitchCard', 'MemoryUsageCard', 'StorageIoCard', 'PageFaultsCard',
    ...(start.platform === 'android' ? ['ThermalHeadroomCard', 'BatteryTemperatureCard', 'BatteryCurrentCard', 'BatteryVoltageCard', 'BatteryChargeCard', 'BatteryRefreshProbe', 'SystemMemoryCard'] : [])];
  if (mode !== 'paused' && expected.some(owner => !activity.stateWrites[owner]))
    throw new Error('An expected collector did not update during the measurement');
  return { index, mode, percent: usage.percent, userPercent: usage.userPercent, systemPercent: usage.systemPercent,
    cpuDeltaMs: usage.cpuDeltaMs, elapsedMs: usage.elapsedMs, start, end, activity };
}
export function overheadSummary(windows: OverheadWindow[]) {
  if (windows.length !== OVERHEAD_ORDER.length || windows.some((w, i) => w.index !== i || w.mode !== OVERHEAD_ORDER[i]))
    throw new Error('A complete nine-window comparison is required');
  const modes = (['paused', 'collect', 'live'] as const).map(mode => {
    const values = windows.filter(w => w.mode === mode).map(w => w.percent).sort((a, b) => a - b);
    return { mode, median: values[1], min: values[0], max: values[2] };
  });
  return { modes, collectionPoints: modes[1].median - modes[0].median,
    displayPoints: modes[2].median - modes[1].median, combinedPoints: modes[2].median - modes[0].median };
}

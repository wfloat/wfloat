import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERHEAD_ORDER, overheadSummary, overheadWindow } from '../src/overhead.ts';
import { MetricPublication } from '../src/metricPublication.ts';

const sample = (time, cpu, extra = {}) => ({
  userCpuTimeUs: cpu * 1000, systemCpuTimeUs: 0, cpuTimeMs: cpu,
  queryStartedUptimeMs: time, queryFinishedUptimeMs: time, monotonicMs: time,
  sampledAtMs: time + 1700000000000, processId: 5, sequence: time + 1,
  platform: 'ios', osVersion: '18.0', source: 'getrusage(RUSAGE_SELF):ru_utime,ru_stime',
  clockSource: 'NSProcessInfo.systemUptime', ...extra,
});
test('phase order balances each mode across first, second and third positions', () => {
  for (let column = 0; column < 3; column++)
    assert.equal(new Set([0, 1, 2].map(row => OVERHEAD_ORDER[row * 3 + column])).size, 3);
});
test('window uses real native elapsed time and rejects changed processes or long delays', () => {
  const activity = { stateWrites: {}, stateHookRenders: 0, errors: [] };
  assert.equal(overheadWindow(0, 'paused', sample(1000, 10), sample(21200, 212, {sequence: 1002}), activity).percent, 1);
  for (const end of [sample(30000, 212), sample(15000, 212), sample(21200, 212, {processId: 6})])
    assert.throws(() => overheadWindow(0, 'paused', sample(1000, 10), end, activity));
});
test('invalid controls cannot produce a successful frozen or paused comparison', () => {
  const start = sample(1000, 0), end = sample(21000, 100);
  assert.throws(() => overheadWindow(0, 'paused', start, end, {stateWrites: {CpuUsageCard: 1}, stateHookRenders: 0, errors: []}));
  assert.throws(() => overheadWindow(1, 'collect', start, end, {stateWrites: {CpuUsageCard: 20}, stateHookRenders: 1, errors: []}));
  assert.throws(() => overheadWindow(1, 'collect', start, end, {stateWrites: {}, stateHookRenders: 0, errors: []}));
});
test('summary rejects partial results and preserves negative differences instead of clipping', () => {
  assert.throws(() => overheadSummary([]));
  const windows = OVERHEAD_ORDER.map((mode, index) => ({ mode, index, percent: mode === 'paused' ? 2 : mode === 'collect' ? 1 : 3 }));
  const s = overheadSummary(windows);
  assert.equal(s.collectionPoints, -1); assert.equal(s.displayPoints, 2); assert.equal(s.combinedPoints, 1);
});
test('publication audit records writes without requiring publication and excludes warmup', () => {
  const meter = new MetricPublication(); meter.write('CpuUsageCard.usage', {});
  assert.deepEqual(meter.snapshot().stateWrites, {});
  meter.publish = false; meter.recording = true;
  meter.write('CpuUsageCard.usage', {}); meter.write('CpuUsageCard.error', 'Read failed');
  assert.deepEqual(meter.snapshot(), {stateWrites: {CpuUsageCard: 2}, stateHookRenders: 0, errors: ['CpuUsageCard.error: Read failed']});
  meter.render(); assert.equal(meter.snapshot().stateHookRenders, 1);
  meter.reset(); assert.deepEqual(meter.snapshot(), {stateWrites: {}, stateHookRenders: 0, errors: []});
});

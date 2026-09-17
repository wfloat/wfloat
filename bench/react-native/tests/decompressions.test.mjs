import assert from 'node:assert/strict';
import test from 'node:test';
import { DecompressionTracker, validateDecompressions, DECOMPRESSION_LIMIT } from '../src/decompressions.ts';
import { validateMemorySample } from '../src/memory.ts';

const row = (count = 0, sequence = 1) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence,
  sampledAtMs: 1800000000000 + sequence * 2000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: sequence * 2000 + 1, queryStartedUptimeMs: sequence * 2000,
  queryFinishedUptimeMs: sequence * 2000 + 2, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  decompressions: { count, rawCount: String(count), source: 'task_info(TASK_VM_INFO).decompressions',
    scope: 'calling_process', unit: 'events', aggregation: 'cumulative',
    saturated: count === DECOMPRESSION_LIMIT, environment: 'simulator', error: null },
});

test('decompressions preserve zero and derive event rate using actual query midpoints', () => {
  const tracker = new DecompressionTracker();
  assert.equal(tracker.record(row()).rate, null);
  assert.equal(tracker.record(row(0, 2)).rate.perSecond, 0);
  const s = row(30, 3); s.queryFinishedUptimeMs += 1000;
  const { rate } = tracker.record(s);
  assert.deepEqual(rate, { delta: 30, elapsedMs: 2500, perSecond: 12 });
});
test('counter saturation preserves a lower-bound total without reporting false inactivity', () => {
  const tracker = new DecompressionTracker();
  tracker.record(row(DECOMPRESSION_LIMIT - 1));
  const result = tracker.record(row(DECOMPRESSION_LIMIT, 2));
  assert.equal(result.counter.count, DECOMPRESSION_LIMIT); assert.equal(result.counter.saturated, true);
  assert.equal(result.rate, null); assert.equal(tracker.record(row(DECOMPRESSION_LIMIT, 3)).rate, null);
  const invalid = row(DECOMPRESSION_LIMIT); invalid.decompressions.saturated = false;
  assert.throws(() => validateDecompressions(invalid));
});
test('missing and failed counters leave RSS available and reset the rate baseline', () => {
  const tracker = new DecompressionTracker(); tracker.record(row(4));
  const s = row(5, 2);
  s.decompressions = { ...s.decompressions, count: null, rawCount: null, error: 'Short reply' };
  assert.equal(tracker.record(s).counter.count, null); assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(tracker.record(row(10, 3)).rate, null);
  delete s.decompressions; assert.throws(() => tracker.record(s));
  assert.equal(tracker.record(row(20, 4)).rate, null);
  const negative = row(); negative.decompressions = { ...negative.decompressions, count: null, rawCount: '-1', error: 'Negative counter' };
  assert.equal(validateDecompressions(negative).rawCount, '-1');
});
test('resume, process changes and missing samples establish fresh baselines', () => {
  const tracker = new DecompressionTracker(); tracker.record(row(4)); tracker.resetWindow();
  assert.equal(tracker.record(row(20, 2)).rate, null);
  assert.equal(tracker.record(row(50, 4)).rate, null);
  assert.equal(tracker.record({ ...row(2, 1), processId: 124 }).rate, null);
  assert.equal(tracker.record({ ...row(3, 2), processId: 124 }).rate.delta, 1);
  assert.equal(tracker.record({ ...row(0, 1), osVersion: '19.0' }).rate, null);
});
test('decreases, reordered and overlapping samples fail instead of producing misleading rates', () => {
  for (const s of [row(9, 2), row(10, 1), { ...row(11, 2), queryStartedUptimeMs: 2001, monotonicMs: 2002 }]) {
    const tracker = new DecompressionTracker(); tracker.record(row(10));
    assert.throws(() => tracker.record(s)); assert.equal(tracker.record(row(20, 3)).rate, null);
  }
});
test('decompressions reject wrong units, source, scope, precision and availability', () => {
  for (const change of [{ unit: 'bytes' }, { source: 'vm_stat' }, { scope: 'device' }, { aggregation: 'gauge' },
    { environment: 'unknown' }, { count: -1 }, { count: .5 }, { count: DECOMPRESSION_LIMIT + 1 },
    { rawCount: '00' }, { rawCount: '1' }, { rawCount: null }, { saturated: true }, { error: 'failed' },
    { count: null, rawCount: '0', error: 'failed' }, { count: null, rawCount: '-2147483649', error: 'failed' }])
    assert.throws(() => validateDecompressions({ ...row(), decompressions: { ...row().decompressions, ...change } }));
});
test('decompressions validate native process, platform, sequence and clock metadata', () => {
  for (const change of [{ platform: 'android' }, { processId: 0 }, { sequence: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 1 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateDecompressions({ ...row(), ...change }));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndroidVmas, validateMemorySample } from '../src/memory.ts';

const row = (count = 37) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 24576, source: '/proc/self/smaps_rollup:Pss', error: null },
  vmas: { count, rawCount: String(count), source: '/proc/self/maps:count(VMA)',
    scope: 'calling_process', unit: 'regions', aggregation: 'gauge', error: null },
});
test('VMA count is a gauge: zero, increases, decreases and collector maximum are valid', () => {
  for (const count of [0, 37, 101, 37, 2147483647]) assert.equal(validateAndroidVmas(row(count)).count, count);
});
test('unavailable or missing VMAs do not invalidate RSS or PSS', () => {
  const s = row(); s.vmas = { ...s.vmas, count: null, rawCount: null, error: 'Incomplete memory-map record' };
  assert.equal(validateAndroidVmas(s).count, null);
  assert.equal(validateMemorySample(s).pss.bytes, 24576);
  delete s.vmas; assert.throws(() => validateAndroidVmas(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('VMA count rejects malformed, mismatched, out-of-range or hidden valid values', () => {
  const s = row();
  for (const change of [{ count: -1 }, { count: 1.5 }, { count: NaN }, { count: 2147483648 },
    { rawCount: null }, { rawCount: '38' }, { rawCount: '037' }, { rawCount: '+37' },
    { rawCount: '-0' }, { rawCount: '-1', count: null, error: 'negative' }, { rawCount: '-2147483649' }, { rawCount: '2147483648' },
    { rawCount: '1e3' }, { rawCount: 37 }, { count: null, error: 'Failed' }, { error: 'Failed' },
    { count: null, rawCount: null, error: '' }])
    assert.throws(() => validateAndroidVmas({ ...s, vmas: { ...s.vmas, ...change } }));
});
test('VMA source, gauge semantics, scope and units stay explicit', () => {
  const s = row();
  for (const change of [{ scope: 'process_lifetime' }, { unit: 'bytes' }, { aggregation: 'cumulative' },
    { source: 'task_info(TASK_VM_INFO).page_size' }, { source: 'task_info(TASK_VM_INFO).region_count' }])
    assert.throws(() => validateAndroidVmas({ ...s, vmas: { ...s.vmas, ...change } }));
  assert.equal(validateAndroidVmas({ ...s, source: '/proc/self/smaps:sum(Rss)' }).count, 37);
});
test('VMAs reject incorrect platform, clock and sample metadata', () => {
  for (const change of [{ platform: 'ios' }, { source: '/proc/self/maps' }, { processId: 0 },
    { sequence: 0 }, { apiLevel: 23 }, { osVersion: '' }, { clockSource: 'Date.now' }, { monotonicMs: 999 },
    { queryStartedUptimeMs: NaN }, { queryFinishedUptimeMs: 999 }])
    assert.throws(() => validateAndroidVmas({ ...row(), ...change }));
});

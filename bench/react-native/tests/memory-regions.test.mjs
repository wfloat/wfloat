import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemoryRegions, validateMemorySample } from '../src/memory.ts';

const row = (count = 37) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  regions: { count, rawCount: String(count), source: 'task_info(TASK_VM_INFO).region_count',
    scope: 'calling_process', unit: 'regions', aggregation: 'gauge', environment: 'simulator', error: null },
});
test('region count is a gauge: zero, increases, decreases and signed maximum are valid', () => {
  for (const count of [0, 37, 101, 37, 2147483647]) assert.equal(validateMemoryRegions(row(count)).count, count);
});
test('unavailable or missing regions do not invalidate RSS or footprint', () => {
  const s = row(); s.regions = { ...s.regions, count: null, rawCount: null, error: 'Short Mach reply' };
  assert.equal(validateMemoryRegions(s).count, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.regions; assert.throws(() => validateMemoryRegions(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('negative Mach values remain exact diagnostics and never become counts', () => {
  for (const rawCount of ['-1', '-2147483648']) {
    const s = row(); s.regions = { ...s.regions, count: null, rawCount, error: 'Negative Mach memory-region count' };
    assert.equal(validateMemoryRegions(s).rawCount, rawCount);
    assert.throws(() => validateMemoryRegions({ ...s, regions: { ...s.regions, count: 0, error: null } }));
  }
});
test('region count rejects malformed, mismatched, out-of-range or hidden valid values', () => {
  const s = row();
  for (const change of [{ count: -1 }, { count: 1.5 }, { count: NaN }, { count: 2147483648 },
    { rawCount: null }, { rawCount: '38' }, { rawCount: '037' }, { rawCount: '+37' },
    { rawCount: '-0' }, { rawCount: '-2147483649' }, { rawCount: '2147483648' },
    { rawCount: '1e3' }, { rawCount: 37 }, { count: null, error: 'Failed' }, { error: 'Failed' },
    { count: null, rawCount: null, error: '' }])
    assert.throws(() => validateMemoryRegions({ ...s, regions: { ...s.regions, ...change } }));
});
test('region source, gauge semantics, scope, units and environment stay explicit', () => {
  const s = row();
  for (const change of [{ scope: 'process_lifetime' }, { unit: 'bytes' }, { aggregation: 'cumulative' },
    { source: 'task_info(TASK_VM_INFO).page_size' }, { environment: 'unknown' }])
    assert.throws(() => validateMemoryRegions({ ...s, regions: { ...s.regions, ...change } }));
  assert.equal(validateMemoryRegions({ ...s, regions: { ...s.regions, environment: 'device' } }).environment, 'device');
});
test('regions reject incorrect platform, clock and sample metadata', () => {
  for (const change of [{ platform: 'android' }, { source: '/proc/self/maps' }, { processId: 0 },
    { sequence: 0 }, { osVersion: '' }, { clockSource: 'Date.now' }, { monotonicMs: 999 },
    { queryStartedUptimeMs: NaN }, { queryFinishedUptimeMs: 999 }])
    assert.throws(() => validateMemoryRegions({ ...row(), ...change }));
});

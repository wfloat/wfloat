import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateVirtualMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  virtualSize: { bytes, rawBytes: String(bytes), source: '/proc/self/status:VmSize',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('virtual is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateVirtualMemory(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('virtual source remains status when RSS uses either smaps path', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.equal(validateVirtualMemory(s).bytes, 4096);
  s.virtualSize.source = '/proc/self/smaps:sum(VmSize)';
  assert.throws(() => validateVirtualMemory(s));
});
test('missing or failed virtual leaves existing memory values usable', () => {
  const s = row(); s.virtualSize = { ...s.virtualSize, bytes: null, rawBytes: null, error: 'Missing VmSize entry in status' };
  assert.equal(validateVirtualMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.virtualSize;
  assert.throws(() => validateVirtualMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw virtual bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateVirtualMemory({ ...s, virtualSize: { ...s.virtualSize, ...change } }));
  const imprecise = { ...s, virtualSize: { ...s.virtualSize, bytes: null,
    rawBytes: '9007199254740992', error: 'Virtual memory exceeds exact JavaScript integer range' } };
  assert.equal(validateVirtualMemory(imprecise).rawBytes, '9007199254740992');
});
test('virtual rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateVirtualMemory({ ...s, virtualSize: { ...s.virtualSize, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateVirtualMemory({ ...s, ...change }));
});

const ios = (bytes = 1099511627776) => ({ ...row(bytes), platform: 'ios', osVersion: '18.0',
  clockSource: 'NSProcessInfo.systemUptime', source: 'task_info(MACH_TASK_BASIC_INFO).resident_size',
  virtualSize: { ...row(bytes).virtualSize, source: 'task_info(MACH_TASK_BASIC_INFO).virtual_size' },
});
test('iOS virtual size accepts large address-space values and decreases independently of RSS', () => {
  for (const bytes of [1099511627776, 1099578736640, 1099511627776, 0])
    assert.equal(validateVirtualMemory(ios(bytes)).bytes, bytes);
  const s = ios(); s.virtualSize = { ...s.virtualSize, bytes: null, rawBytes: null, error: 'Unavailable' };
  assert.equal(validateVirtualMemory(s).bytes, null); assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('iOS virtual size rejects wrong Mach field, clock and raw precision', () => {
  const s = ios();
  for (const change of [{ source: 'task_info(TASK_VM_INFO).phys_footprint' }, { rawBytes: '1099511627777' },
    { unit: 'pages' }, { scope: 'device' }])
    assert.throws(() => validateVirtualMemory({ ...s, virtualSize: { ...s.virtualSize, ...change } }));
  assert.throws(() => validateVirtualMemory({ ...s, clockSource: 'SystemClock.elapsedRealtimeNanos' }));
  const huge = { ...s, virtualSize: { ...s.virtualSize, bytes: null, rawBytes: '18446744073709551615', error: 'Inexact' } };
  assert.equal(validateVirtualMemory(huge).rawBytes, '18446744073709551615');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateLockedMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  locked: { bytes, rawBytes: String(bytes), source: '/proc/self/status:VmLck',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('locked is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateLockedMemory(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('locked source remains status when RSS uses either smaps path', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.equal(validateLockedMemory(s).bytes, 4096);
  s.locked.source = '/proc/self/smaps:sum(VmLck)';
  assert.throws(() => validateLockedMemory(s));
});
test('missing or failed locked leaves existing memory values usable', () => {
  const s = row(); s.locked = { ...s.locked, bytes: null, rawBytes: null, error: 'Missing VmLck entry in status' };
  assert.equal(validateLockedMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.locked;
  assert.throws(() => validateLockedMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw locked bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateLockedMemory({ ...s, locked: { ...s.locked, ...change } }));
  const imprecise = { ...s, locked: { ...s.locked, bytes: null,
    rawBytes: '9007199254740992', error: 'Locked memory exceeds exact JavaScript integer range' } };
  assert.equal(validateLockedMemory(imprecise).rawBytes, '9007199254740992');
});
test('locked rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateLockedMemory({ ...s, locked: { ...s.locked, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateLockedMemory({ ...s, ...change }));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateLazyFreeMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  lazyFree: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:LazyFree',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('lazily freeable memory is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateLazyFreeMemory(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('lazily freeable memory preserves rollup versus mapping-sum provenance', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateLazyFreeMemory(s));
  s.lazyFree.source = '/proc/self/smaps:sum(LazyFree)';
  assert.equal(validateLazyFreeMemory(s).bytes, 4096);
});
test('missing or failed lazily freeable memory leaves existing memory values usable', () => {
  const s = row(); s.lazyFree = { ...s.lazyFree, bytes: null, rawBytes: null, error: 'Missing LazyFree entry in smaps' };
  assert.equal(validateLazyFreeMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.lazyFree;
  assert.throws(() => validateLazyFreeMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw lazily freeable memory bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateLazyFreeMemory({ ...s, lazyFree: { ...s.lazyFree, ...change } }));
  const imprecise = { ...s, lazyFree: { ...s.lazyFree, bytes: null,
    rawBytes: '9007199254740992', error: 'Lazy-free memory exceeds exact JavaScript integer range' } };
  assert.equal(validateLazyFreeMemory(imprecise).rawBytes, '9007199254740992');
});
test('lazily freeable memory rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateLazyFreeMemory({ ...s, lazyFree: { ...s.lazyFree, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateLazyFreeMemory({ ...s, ...change }));
});

test('lazily freeable memory is independent of total PSS and resident dirty counters', () => {
  const s = row();
  s.pss = { ...s.pss, bytes: null, error: 'Missing Pss' };
  s.privateDirty = { bytes: null, rawBytes: null, source: '/proc/self/smaps_rollup:Private_Dirty', scope: 'calling_process', unit: 'bytes', error: 'Missing' };
  assert.equal(validateLazyFreeMemory(s).bytes, 4096);
  s.lazyFree.source = '/proc/self/smaps_rollup:Shared_Dirty';
  assert.throws(() => validateLazyFreeMemory(s));
});

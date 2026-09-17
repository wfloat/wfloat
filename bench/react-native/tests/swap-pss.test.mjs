import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateSwapPss } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  swapPss: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:SwapPss',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('proportional swap is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateSwapPss(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('proportional swap preserves rollup versus mapping-sum provenance', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateSwapPss(s));
  s.swapPss.source = '/proc/self/smaps:sum(SwapPss)';
  assert.equal(validateSwapPss(s).bytes, 4096);
});
test('missing or failed proportional swap leaves existing memory values usable', () => {
  const s = row(); s.swapPss = { ...s.swapPss, bytes: null, rawBytes: null, error: 'Missing SwapPss entry in smaps' };
  assert.equal(validateSwapPss(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.swapPss;
  assert.throws(() => validateSwapPss(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw proportional swap bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateSwapPss({ ...s, swapPss: { ...s.swapPss, ...change } }));
  const imprecise = { ...s, swapPss: { ...s.swapPss, bytes: null,
    rawBytes: '9007199254740992', error: 'Proportional swap memory exceeds exact JavaScript integer range' } };
  assert.equal(validateSwapPss(imprecise).rawBytes, '9007199254740992');
});
test('proportional swap rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateSwapPss({ ...s, swapPss: { ...s.swapPss, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateSwapPss({ ...s, ...change }));
});

test('swap share can exceed RSS and PSS without being clamped or added to either', () => {
  const s = row(67108864);
  assert.equal(validateSwapPss(s).bytes, 67108864);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
});

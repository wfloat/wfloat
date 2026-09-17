import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validatePrivateClean } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  privateClean: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:Private_Clean',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('private clean is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validatePrivateClean(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('private clean preserves rollup versus mapping-sum provenance', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validatePrivateClean(s));
  s.privateClean.source = '/proc/self/smaps:sum(Private_Clean)';
  assert.equal(validatePrivateClean(s).bytes, 4096);
});
test('missing or failed private clean leaves existing memory values usable', () => {
  const s = row(); s.privateClean = { ...s.privateClean, bytes: null, rawBytes: null, error: 'Missing Private_Clean entry in smaps' };
  assert.equal(validatePrivateClean(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.privateClean;
  assert.throws(() => validatePrivateClean(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw private clean bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validatePrivateClean({ ...s, privateClean: { ...s.privateClean, ...change } }));
  const imprecise = { ...s, privateClean: { ...s.privateClean, bytes: null,
    rawBytes: '9007199254740992', error: 'Private clean memory exceeds exact JavaScript integer range' } };
  assert.equal(validatePrivateClean(imprecise).rawBytes, '9007199254740992');
});
test('private clean rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validatePrivateClean({ ...s, privateClean: { ...s.privateClean, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validatePrivateClean({ ...s, ...change }));
});

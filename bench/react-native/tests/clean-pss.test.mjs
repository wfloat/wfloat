import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCleanPss, validateMemorySample, validateDirtyPss } from '../src/memory.ts';

const row = (total = 12288, dirty = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: total, source: '/proc/self/smaps_rollup:Pss', error: null },
  dirtyPss: { bytes: dirty, rawBytes: String(dirty), source: '/proc/self/smaps_rollup:Pss_Dirty',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('clean PSS is explicitly derived from the same sample and does not mutate it', () => {
  const s = row(); const original = structuredClone(s);
  assert.deepEqual(deriveCleanPss(s), { bytes: 8192, error: null,
    source: 'derived(/proc/self/smaps_rollup:Pss - /proc/self/smaps_rollup:Pss_Dirty)',
    scope: 'calling_process', unit: 'bytes', derivation: 'total_pss_minus_dirty_pss' });
  assert.deepEqual(s, original);
});
test('zero, all-clean, all-dirty, decreases and exact safe integers are supported', () => {
  for (const [total, dirty, expected] of [[0, 0, 0], [8192, 0, 8192], [8192, 8192, 0],
    [12288, 4096, 8192], [12288, 8192, 4096], [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER - 1]])
    assert.equal(deriveCleanPss(row(total, dirty)).bytes, expected);
});
test('fallback sums preserve their provenance and reject mixed input sources', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  s.dirtyPss.source = '/proc/self/smaps:sum(Pss_Dirty)';
  assert.throws(() => deriveCleanPss(s), /matching/);
  s.pss.source = '/proc/self/smaps:sum(Pss)';
  const derived = deriveCleanPss(s);
  assert.equal(derived.bytes, 8192);
  assert.equal(derived.source, 'derived(/proc/self/smaps:sum(Pss) - /proc/self/smaps:sum(Pss_Dirty))');
});
test('unavailable inputs retain reasons and valid source values remain independent', () => {
  const totalMissing = row(); totalMissing.pss = { ...totalMissing.pss, bytes: null, error: 'Missing Pss' };
  assert.equal(deriveCleanPss(totalMissing).bytes, null);
  assert.match(deriveCleanPss(totalMissing).error, /Total PSS: Missing Pss/);
  assert.equal(validateDirtyPss(totalMissing).bytes, 4096);
  const dirtyMissing = row(); dirtyMissing.dirtyPss = { ...dirtyMissing.dirtyPss, bytes: null, rawBytes: null, error: 'Missing Pss_Dirty' };
  assert.equal(deriveCleanPss(dirtyMissing).bytes, null);
  assert.match(deriveCleanPss(dirtyMissing).error, /Dirty PSS: Missing Pss_Dirty/);
  assert.equal(validateMemorySample(dirtyMissing).pss.bytes, 12288);
  const bothMissing = { ...dirtyMissing, pss: totalMissing.pss };
  assert.match(deriveCleanPss(bothMissing).error, /Total PSS: Missing Pss; Dirty PSS: Missing Pss_Dirty/);
});
test('contradictory readings are unavailable rather than clamped to zero', () => {
  const s = row(4096, 8192);
  assert.equal(deriveCleanPss(s).bytes, null);
  assert.match(deriveCleanPss(s).error, /exceeds/);
  assert.equal(validateMemorySample(s).pss.bytes, 4096);
  assert.equal(validateDirtyPss(s).bytes, 8192);
});
test('missing collectors, invalid timing, source, scope and precision cannot produce clean PSS', () => {
  for (const s of [ { ...row(), pss: undefined }, { ...row(), dirtyPss: undefined },
    { ...row(), platform: 'ios' }, { ...row(), sequence: 0 }, { ...row(), queryFinishedUptimeMs: 999 },
    { ...row(), pss: { ...row().pss, source: '/proc/self/smaps_rollup:Private_Clean' } },
    { ...row(), dirtyPss: { ...row().dirtyPss, scope: 'device' } },
    { ...row(), dirtyPss: { ...row().dirtyPss, rawBytes: '4097' } },
    row(Number.MAX_SAFE_INTEGER + 1), row(NaN), row(-1), row(1.5)])
    assert.throws(() => deriveCleanPss(s));
  const s = row(); s.dirtyPss = { ...s.dirtyPss, bytes: null, rawBytes: '9007199254740992', error: 'Precision limit' };
  assert.equal(deriveCleanPss(s).bytes, null);
  assert.match(deriveCleanPss(s).error, /Precision limit/);
});
test('unweighted clean/dirty resident counters and category totals are not substitutes', () => {
  const s = { ...row(), privateClean: { bytes: 999999 }, sharedClean: { bytes: 888888 },
    privateDirty: { bytes: 777777 }, anonymousPss: { bytes: 666666 } };
  assert.equal(deriveCleanPss(s).bytes, 8192);
});

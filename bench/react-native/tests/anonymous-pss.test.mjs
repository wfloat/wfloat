import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateAnonymousPss } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  anonymousPss: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:Pss_Anon',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('anonymous PSS is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateAnonymousPss(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('anonymous PSS requires rollup data and keeps fallback explicitly unavailable', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateAnonymousPss(s));
  s.anonymousPss = { ...s.anonymousPss, bytes: null, rawBytes: null, error: 'Pss_Anon requires smaps_rollup; no fallback estimate' };
  assert.equal(validateAnonymousPss(s).bytes, null);
  s.anonymousPss.source = '/proc/self/smaps:sum(Pss_Anon)';
  assert.throws(() => validateAnonymousPss(s));
});
test('missing or failed anonymous PSS leaves existing memory values usable', () => {
  const s = row(); s.anonymousPss = { ...s.anonymousPss, bytes: null, rawBytes: null, error: 'Missing Pss_Anon entry in smaps_rollup' };
  assert.equal(validateAnonymousPss(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.anonymousPss;
  assert.throws(() => validateAnonymousPss(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw anonymous PSS bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateAnonymousPss({ ...s, anonymousPss: { ...s.anonymousPss, ...change } }));
  const imprecise = { ...s, anonymousPss: { ...s.anonymousPss, bytes: null,
    rawBytes: '9007199254740992', error: 'Anonymous PSS exceeds exact JavaScript integer range' } };
  assert.equal(validateAnonymousPss(imprecise).rawBytes, '9007199254740992');
});
test('anonymous PSS rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateAnonymousPss({ ...s, anonymousPss: { ...s.anonymousPss, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateAnonymousPss({ ...s, ...change }));
});

test('anonymous PSS is independent of anonymous RSS and total PSS availability', () => {
  const s = row(8192);
  s.anonymous = { bytes: 16384, rawBytes: '16384', source: '/proc/self/smaps_rollup:Anonymous', scope: 'calling_process', unit: 'bytes', error: null };
  assert.equal(validateAnonymousPss(s).bytes, 8192);
  s.pss = { ...s.pss, bytes: null, error: 'Unavailable' };
  s.anonymous = { ...s.anonymous, bytes: null, rawBytes: null, error: 'Unavailable' };
  assert.equal(validateAnonymousPss(s).bytes, 8192);
});

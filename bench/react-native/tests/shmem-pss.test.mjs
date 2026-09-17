import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateShmemPss } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  shmemPss: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:Pss_Shmem',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('shared-memory PSS is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateShmemPss(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('shared-memory PSS requires rollup data and keeps fallback explicitly unavailable', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateShmemPss(s));
  s.shmemPss = { ...s.shmemPss, bytes: null, rawBytes: null, error: 'Pss_Shmem requires smaps_rollup; no fallback estimate' };
  assert.equal(validateShmemPss(s).bytes, null);
  s.shmemPss.source = '/proc/self/smaps:sum(Pss_Shmem)';
  assert.throws(() => validateShmemPss(s));
});
test('missing or failed shared-memory PSS leaves existing memory values usable', () => {
  const s = row(); s.shmemPss = { ...s.shmemPss, bytes: null, rawBytes: null, error: 'Missing Pss_Shmem entry in smaps_rollup' };
  assert.equal(validateShmemPss(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.shmemPss;
  assert.throws(() => validateShmemPss(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw shared-memory PSS bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateShmemPss({ ...s, shmemPss: { ...s.shmemPss, ...change } }));
  const imprecise = { ...s, shmemPss: { ...s.shmemPss, bytes: null,
    rawBytes: '9007199254740992', error: 'Shared-memory PSS exceeds exact JavaScript integer range' } };
  assert.equal(validateShmemPss(imprecise).rawBytes, '9007199254740992');
});
test('shared-memory PSS rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateShmemPss({ ...s, shmemPss: { ...s.shmemPss, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateShmemPss({ ...s, ...change }));
});

test('shared-memory PSS is independent of anonymous RSS and total PSS availability', () => {
  const s = row(8192);
  s.anonymous = { bytes: 16384, rawBytes: '16384', source: '/proc/self/smaps_rollup:Anonymous', scope: 'calling_process', unit: 'bytes', error: null };
  assert.equal(validateShmemPss(s).bytes, 8192);
  s.pss = { ...s.pss, bytes: null, error: 'Unavailable' };
  s.anonymous = { ...s.anonymous, bytes: null, rawBytes: null, error: 'Unavailable' };
  assert.equal(validateShmemPss(s).bytes, 8192);
});

test('shmem PSS survives missing anonymous PSS and does not accept that field as its source', () => {
  const s = row();
  s.anonymousPss = { bytes: null, rawBytes: null, source: '/proc/self/smaps_rollup:Pss_Anon', scope: 'calling_process', unit: 'bytes', error: 'Missing field' };
  assert.equal(validateShmemPss(s).bytes, 4096);
  s.shmemPss.source = '/proc/self/smaps_rollup:Pss_Anon';
  assert.throws(() => validateShmemPss(s));
});

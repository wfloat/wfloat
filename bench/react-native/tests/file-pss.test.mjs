import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateFilePss } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  filePss: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:Pss_File',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('file-backed PSS is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateFilePss(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('file-backed PSS requires rollup data and keeps fallback explicitly unavailable', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateFilePss(s));
  s.filePss = { ...s.filePss, bytes: null, rawBytes: null, error: 'Pss_File requires smaps_rollup; no fallback estimate' };
  assert.equal(validateFilePss(s).bytes, null);
  s.filePss.source = '/proc/self/smaps:sum(Pss_File)';
  assert.throws(() => validateFilePss(s));
});
test('missing or failed file-backed PSS leaves existing memory values usable', () => {
  const s = row(); s.filePss = { ...s.filePss, bytes: null, rawBytes: null, error: 'Missing Pss_File entry in smaps_rollup' };
  assert.equal(validateFilePss(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.filePss;
  assert.throws(() => validateFilePss(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw file-backed PSS bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateFilePss({ ...s, filePss: { ...s.filePss, ...change } }));
  const imprecise = { ...s, filePss: { ...s.filePss, bytes: null,
    rawBytes: '9007199254740992', error: 'File-backed PSS exceeds exact JavaScript integer range' } };
  assert.equal(validateFilePss(imprecise).rawBytes, '9007199254740992');
});
test('file-backed PSS rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateFilePss({ ...s, filePss: { ...s.filePss, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateFilePss({ ...s, ...change }));
});

test('file-backed PSS is independent of anonymous RSS and total PSS availability', () => {
  const s = row(8192);
  s.anonymous = { bytes: 16384, rawBytes: '16384', source: '/proc/self/smaps_rollup:Anonymous', scope: 'calling_process', unit: 'bytes', error: null };
  assert.equal(validateFilePss(s).bytes, 8192);
  s.pss = { ...s.pss, bytes: null, error: 'Unavailable' };
  s.anonymous = { ...s.anonymous, bytes: null, rawBytes: null, error: 'Unavailable' };
  assert.equal(validateFilePss(s).bytes, 8192);
});

test('file PSS survives missing anonymous PSS and does not accept that field as its source', () => {
  const s = row();
  s.anonymousPss = { bytes: null, rawBytes: null, source: '/proc/self/smaps_rollup:Pss_Anon', scope: 'calling_process', unit: 'bytes', error: 'Missing field' };
  assert.equal(validateFilePss(s).bytes, 4096);
  s.filePss.source = '/proc/self/smaps_rollup:Pss_Anon';
  assert.throws(() => validateFilePss(s));
});

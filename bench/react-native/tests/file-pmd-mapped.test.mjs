import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateFilePmdMapped } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  filePmdMapped: { bytes, rawBytes: String(bytes), source: '/proc/self/smaps_rollup:FilePmdMapped',
    scope: 'calling_process', unit: 'bytes', error: null },
});
test('file huge-page memory is a separate gauge with valid zero and decreases', () => {
  for (const bytes of [4096, 8192, 0, 4096]) assert.equal(validateFilePmdMapped(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('file huge-page memory preserves rollup versus mapping-sum provenance', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.throws(() => validateFilePmdMapped(s));
  s.filePmdMapped.source = '/proc/self/smaps:sum(FilePmdMapped)';
  assert.equal(validateFilePmdMapped(s).bytes, 4096);
});
test('missing or failed file huge-page memory leaves existing memory values usable', () => {
  const s = row(); s.filePmdMapped = { ...s.filePmdMapped, bytes: null, rawBytes: null, error: 'Missing FilePmdMapped entry in smaps' };
  assert.equal(validateFilePmdMapped(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.filePmdMapped;
  assert.throws(() => validateFilePmdMapped(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw file huge-page memory bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateFilePmdMapped({ ...s, filePmdMapped: { ...s.filePmdMapped, ...change } }));
  const imprecise = { ...s, filePmdMapped: { ...s.filePmdMapped, bytes: null,
    rawBytes: '9007199254740992', error: 'File huge-page memory exceeds exact JavaScript integer range' } };
  assert.equal(validateFilePmdMapped(imprecise).rawBytes, '9007199254740992');
});
test('file huge-page memory rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validateFilePmdMapped({ ...s, filePmdMapped: { ...s.filePmdMapped, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateFilePmdMapped({ ...s, ...change }));
});

test('file huge-page memory is independent of total PSS and resident dirty counters', () => {
  const s = row();
  s.pss = { ...s.pss, bytes: null, error: 'Missing Pss' };
  s.privateDirty = { bytes: null, rawBytes: null, source: '/proc/self/smaps_rollup:Private_Dirty', scope: 'calling_process', unit: 'bytes', error: 'Missing' };
  assert.equal(validateFilePmdMapped(s).bytes, 4096);
  s.filePmdMapped.source = '/proc/self/smaps_rollup:Shared_Dirty';
  assert.throws(() => validateFilePmdMapped(s));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validatePeakVirtualMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  pss: { bytes: 12288, source: '/proc/self/smaps_rollup:Pss', error: null },
  peakVirtual: { bytes, rawBytes: String(bytes), source: '/proc/self/status:VmPeak',
    scope: 'process_lifetime', unit: 'bytes', error: null },
});
test('peak virtual memory validates independent snapshots and zero', () => {
  for (const bytes of [0, 4096, 8192]) assert.equal(validatePeakVirtualMemory(row(bytes)).bytes, bytes);
  assert.equal(validateMemorySample(row()).rssBytes, 16384);
  assert.equal(validateMemorySample(row()).pss.bytes, 12288);
});
test('peakVirtual source remains status when RSS uses either smaps path', () => {
  const s = row(); s.source = '/proc/self/smaps:sum(Rss)';
  assert.equal(validatePeakVirtualMemory(s).bytes, 4096);
  s.peakVirtual.source = '/proc/self/smaps:sum(VmPeak)';
  assert.throws(() => validatePeakVirtualMemory(s));
});
test('missing or failed peakVirtual leaves existing memory values usable', () => {
  const s = row(); s.peakVirtual = { ...s.peakVirtual, bytes: null, rawBytes: null, error: 'Missing VmPeak entry in status' };
  assert.equal(validatePeakVirtualMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
  assert.equal(validateMemorySample(s).pss.bytes, 12288);
  delete s.peakVirtual;
  assert.throws(() => validatePeakVirtualMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('raw peakVirtual bytes must agree without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validatePeakVirtualMemory({ ...s, peakVirtual: { ...s.peakVirtual, ...change } }));
  const imprecise = { ...s, peakVirtual: { ...s.peakVirtual, bytes: null,
    rawBytes: '9007199254740992', error: 'Peak virtual memory exceeds exact JavaScript integer range' } };
  assert.equal(validatePeakVirtualMemory(imprecise).rawBytes, '9007199254740992');
});
test('peakVirtual rejects misleading scope, units, source or sample metadata', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'kB' }, { source: '/proc/self/smaps_rollup:Private_Dirty' }])
    assert.throws(() => validatePeakVirtualMemory({ ...s, peakVirtual: { ...s.peakVirtual, ...change } }));
  for (const change of [{ platform: 'ios' }, { source: 'toString' }, { apiLevel: 23 }, { sequence: 0 },
    { clockSource: 'Date.now' }, { queryFinishedUptimeMs: 999 }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validatePeakVirtualMemory({ ...s, ...change }));
});

test('peak is OS supplied rather than synthesized from current virtual size', () => {
  const s = row(16384); s.virtualSize = { bytes: 4096, rawBytes: '4096', source: '/proc/self/status:VmSize', scope: 'calling_process', unit: 'bytes', error: null };
  assert.equal(validatePeakVirtualMemory(s).bytes, 16384);
  s.virtualSize.bytes = null; s.virtualSize.rawBytes = null; s.virtualSize.error = 'Missing';
  assert.equal(validatePeakVirtualMemory(s).bytes, 16384);
  assert.throws(() => validatePeakVirtualMemory({ ...s, peakVirtual: { ...s.peakVirtual, scope: 'calling_process' } }));
});

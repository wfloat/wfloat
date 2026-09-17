import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateIosNativeHeapReserved } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  nativeHeapReserved: { bytes, rawBytes: String(bytes), source: 'malloc_zone_statistics(NULL).size_allocated',
    scope: 'calling_process', unit: 'bytes', accounting: 'malloc_zone_reserved_bytes', environment: 'simulator', zones: 'registered_malloc_zones', error: null },
});
test('iOS native heap reserved is an independent gauge with zero, increases and decreases', () => {
  for (const bytes of [0, 4096, 8192, 4096]) assert.equal(validateIosNativeHeapReserved(row(bytes)).bytes, bytes);
  const s = row(1048576); // Do not impose cross-counter bounds on separately collected accounting.
  assert.equal(validateIosNativeHeapReserved(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('iOS native heap reserved retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.nativeHeapReserved = { ...s.nativeHeapReserved, bytes: null, rawBytes: null, error: 'Missing collector reading' };
  assert.equal(validateIosNativeHeapReserved(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.nativeHeapReserved; assert.throws(() => validateIosNativeHeapReserved(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('iOS native heap reserved requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateIosNativeHeapReserved({ ...s, nativeHeapReserved: { ...s.nativeHeapReserved, ...change } }));
  for (const rawBytes of ['9007199254740992', '18446744073709551615']) {
    const imprecise = { ...s, nativeHeapReserved: { ...s.nativeHeapReserved, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validateIosNativeHeapReserved(imprecise).rawBytes, rawBytes);
  }
});
test('iOS native heap reserved distinguishes allocator zone accounting, source, scope and environment', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'pages' }, { accounting: 'resident_bytes' },
    { environment: 'unknown' }, { zones: 'default_zone_only' }, { source: 'malloc_zone_statistics(NULL).size_allocated_peak' }])
    assert.throws(() => validateIosNativeHeapReserved({ ...s, nativeHeapReserved: { ...s.nativeHeapReserved, ...change } }));
  assert.equal(validateIosNativeHeapReserved({ ...s, nativeHeapReserved: { ...s.nativeHeapReserved, environment: 'device' } }).environment, 'device');
});
test('iOS native heap reserved rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateIosNativeHeapReserved({ ...row(), ...change }));
});

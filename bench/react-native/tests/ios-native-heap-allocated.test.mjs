import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateIosNativeHeapAllocated } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  nativeHeapAllocated: { bytes, rawBytes: String(bytes), source: 'malloc_zone_statistics(NULL).size_in_use',
    scope: 'calling_process', unit: 'bytes', accounting: 'malloc_zone_size_in_use_bytes', environment: 'simulator', zones: 'registered_malloc_zones', error: null },
});
test('iOS native heap is an independent gauge with zero, increases and decreases', () => {
  for (const bytes of [0, 4096, 8192, 4096]) assert.equal(validateIosNativeHeapAllocated(row(bytes)).bytes, bytes);
  const s = row(1048576); // Do not impose cross-counter bounds on separately collected accounting.
  assert.equal(validateIosNativeHeapAllocated(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('iOS native heap retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.nativeHeapAllocated = { ...s.nativeHeapAllocated, bytes: null, rawBytes: null, error: 'Missing collector reading' };
  assert.equal(validateIosNativeHeapAllocated(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.nativeHeapAllocated; assert.throws(() => validateIosNativeHeapAllocated(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('iOS native heap requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateIosNativeHeapAllocated({ ...s, nativeHeapAllocated: { ...s.nativeHeapAllocated, ...change } }));
  for (const rawBytes of ['9007199254740992', '18446744073709551615']) {
    const imprecise = { ...s, nativeHeapAllocated: { ...s.nativeHeapAllocated, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validateIosNativeHeapAllocated(imprecise).rawBytes, rawBytes);
  }
});
test('iOS native heap distinguishes allocator zone accounting, source, scope and environment', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'pages' }, { accounting: 'resident_bytes' },
    { environment: 'unknown' }, { zones: 'default_zone_only' }, { source: 'malloc_zone_statistics(NULL).size_in_use_peak' }])
    assert.throws(() => validateIosNativeHeapAllocated({ ...s, nativeHeapAllocated: { ...s.nativeHeapAllocated, ...change } }));
  assert.equal(validateIosNativeHeapAllocated({ ...s, nativeHeapAllocated: { ...s.nativeHeapAllocated, environment: 'device' } }).environment, 'device');
});
test('iOS native heap rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateIosNativeHeapAllocated({ ...row(), ...change }));
});

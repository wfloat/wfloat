import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateInternalMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  internal: { bytes, rawBytes: String(bytes), source: 'task_info(TASK_VM_INFO).internal',
    scope: 'calling_process', unit: 'bytes', accounting: 'internal_ledger_bytes', environment: 'simulator', error: null },
});
test('internal memory is an independent gauge with zero, increases and decreases', () => {
  for (const bytes of [0, 4096, 8192, 4096]) assert.equal(validateInternalMemory(row(bytes)).bytes, bytes);
  const s = row(1048576); // Do not impose cross-counter bounds on separately collected accounting.
  assert.equal(validateInternalMemory(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('internal memory retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.internal = { ...s.internal, bytes: null, rawBytes: null, error: 'Truncated Mach response' };
  assert.equal(validateInternalMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.internal; assert.throws(() => validateInternalMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('internal memory requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateInternalMemory({ ...s, internal: { ...s.internal, ...change } }));
  for (const rawBytes of ['9007199254740992', '18446744073709551615']) {
    const imprecise = { ...s, internal: { ...s.internal, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validateInternalMemory(imprecise).rawBytes, rawBytes);
  }
});
test('internal memory distinguishes internal page accounting, source, scope and environment', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'pages' }, { accounting: 'internal_storage_bytes' },
    { environment: 'unknown' }, { source: 'task_info(TASK_VM_INFO).internal_peak' }])
    assert.throws(() => validateInternalMemory({ ...s, internal: { ...s.internal, ...change } }));
  assert.equal(validateInternalMemory({ ...s, internal: { ...s.internal, environment: 'device' } }).environment, 'device');
});
test('internal memory rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateInternalMemory({ ...row(), ...change }));
});

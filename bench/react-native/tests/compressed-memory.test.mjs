import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateCompressedMemory } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  compressed: { bytes, rawBytes: String(bytes), source: 'task_info(TASK_VM_INFO).compressed',
    scope: 'calling_process', unit: 'bytes', accounting: 'original_page_bytes', environment: 'simulator', error: null },
});
test('compressed memory is an independent gauge with zero, increases and decreases', () => {
  for (const bytes of [0, 4096, 8192, 4096]) assert.equal(validateCompressedMemory(row(bytes)).bytes, bytes);
  const s = row(1048576); // Compressed accounting is not bounded by current RSS.
  assert.equal(validateCompressedMemory(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('compressed memory retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.compressed = { ...s.compressed, bytes: null, rawBytes: null, error: 'Truncated Mach response' };
  assert.equal(validateCompressedMemory(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.compressed; assert.throws(() => validateCompressedMemory(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('compressed memory requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '18446744073709551616' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validateCompressedMemory({ ...s, compressed: { ...s.compressed, ...change } }));
  for (const rawBytes of ['9007199254740992', '18446744073709551615']) {
    const imprecise = { ...s, compressed: { ...s.compressed, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validateCompressedMemory(imprecise).rawBytes, rawBytes);
  }
});
test('compressed memory distinguishes original page accounting, source, scope and environment', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'pages' }, { accounting: 'compressed_storage_bytes' },
    { environment: 'unknown' }, { source: 'task_info(TASK_VM_INFO).compressed_peak' }])
    assert.throws(() => validateCompressedMemory({ ...s, compressed: { ...s.compressed, ...change } }));
  assert.equal(validateCompressedMemory({ ...s, compressed: { ...s.compressed, environment: 'device' } }).environment, 'device');
});
test('compressed memory rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validateCompressedMemory({ ...row(), ...change }));
});

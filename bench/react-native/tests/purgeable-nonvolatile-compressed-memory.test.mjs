import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validatePurgeableNonvolatileCompressed } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  purgeableNonvolatileCompressed: { bytes, rawBytes: String(bytes), source: 'task_info(TASK_VM_INFO).ledger_purgeable_novolatile_compressed',
    scope: 'calling_process', unit: 'bytes', accounting: 'purgeable_nonvolatile_compressed_original_page_bytes', environment: 'simulator', error: null },
});
test('compressed nonvolatile purgeable memory validates independent OS snapshots including zero', () => {
  for (const bytes of [0, 4096, 8192]) assert.equal(validatePurgeableNonvolatileCompressed(row(bytes)).bytes, bytes);
  const s = row(1048576); // Owned ledger accounting is independent of the separately sampled mapping RSS.
  assert.equal(validatePurgeableNonvolatileCompressed(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('compressed nonvolatile purgeable memory retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.purgeableNonvolatileCompressed = { ...s.purgeableNonvolatileCompressed, bytes: null, rawBytes: null, error: 'Truncated Mach response' };
  assert.equal(validatePurgeableNonvolatileCompressed(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.purgeableNonvolatileCompressed; assert.throws(() => validatePurgeableNonvolatileCompressed(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('compressed nonvolatile purgeable memory requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '9223372036854775808' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validatePurgeableNonvolatileCompressed({ ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, ...change } }));
  for (const rawBytes of ['9007199254740992', '9223372036854775807']) {
    const imprecise = { ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validatePurgeableNonvolatileCompressed(imprecise).rawBytes, rawBytes);
  }
});
test('compressed nonvolatile purgeable memory requires process scope, exact source, byte units and environment', () => {
  const s = row();
  for (const change of [{ scope: 'process_lifetime' }, { accounting: 'compressed_storage_bytes' }, { accounting: 'purgeable_nonvolatile_resident_ledger_bytes' }, { unit: 'pages' }, { environment: 'unknown' }, { source: 'task_info(TASK_VM_INFO).phys_footprint' }])
    assert.throws(() => validatePurgeableNonvolatileCompressed({ ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, ...change } }));
  assert.equal(validatePurgeableNonvolatileCompressed({ ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, environment: 'device' } }).environment, 'device');
});
test('compressed nonvolatile purgeable memory rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validatePurgeableNonvolatileCompressed({ ...row(), ...change }));
});

test('signed Mach errors retain exact raw values without becoming unsigned memory', () => {
  const s = row();
  for (const rawBytes of ['-1', '-9223372036854775808']) {
    const failed = { ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, bytes: null, rawBytes, error: 'Negative Mach compressed nonvolatile purgeable memory' } };
    assert.equal(validatePurgeableNonvolatileCompressed(failed).rawBytes, rawBytes);
    assert.throws(() => validatePurgeableNonvolatileCompressed({ ...failed, purgeableNonvolatileCompressed: { ...failed.purgeableNonvolatileCompressed, bytes: 0, error: null } }));
  }
  for (const rawBytes of ['-0', '-01', '-9223372036854775809', '1.5', '+1'])
    assert.throws(() => validatePurgeableNonvolatileCompressed({ ...s, purgeableNonvolatileCompressed: { ...s.purgeableNonvolatileCompressed, bytes: null, rawBytes, error: 'Invalid' } }));
});
test('ledger stays independent of current-footprint availability and is never clamped', () => {
  const s = row(4096);
  assert.equal(validatePurgeableNonvolatileCompressed(s).bytes, 4096);
  s.physicalFootprint = { ...s.physicalFootprint, bytes: null, error: 'Unavailable' };
  assert.equal(validatePurgeableNonvolatileCompressed(s).bytes, 4096);
});

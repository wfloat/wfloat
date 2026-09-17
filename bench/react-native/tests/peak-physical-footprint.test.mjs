import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validatePeakPhysicalFootprint } from '../src/memory.ts';

const row = (bytes = 4096) => ({
  platform: 'ios', osVersion: '18.0', processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'NSProcessInfo.systemUptime',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: 'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes: 16384, heldBytes: 0,
  physicalFootprint: { bytes: 24576, source: 'task_info(TASK_VM_INFO).phys_footprint', error: null },
  peakPhysicalFootprint: { bytes, rawBytes: String(bytes), source: 'task_info(TASK_VM_INFO).ledger_phys_footprint_peak',
    scope: 'process_lifetime', unit: 'bytes', environment: 'simulator', error: null },
});
test('peak physical footprint validates independent OS snapshots including zero', () => {
  for (const bytes of [0, 4096, 8192]) assert.equal(validatePeakPhysicalFootprint(row(bytes)).bytes, bytes);
  const s = row(1048576); // Peak footprint is not bounded by current RSS.
  assert.equal(validatePeakPhysicalFootprint(s).bytes, 1048576);
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('peak physical footprint retains explicit unavailable state and leaves RSS/footprint usable', () => {
  const s = row(); s.peakPhysicalFootprint = { ...s.peakPhysicalFootprint, bytes: null, rawBytes: null, error: 'Truncated Mach response' };
  assert.equal(validatePeakPhysicalFootprint(s).bytes, null);
  assert.equal(validateMemorySample(s).physicalFootprint.bytes, 24576);
  delete s.peakPhysicalFootprint; assert.throws(() => validatePeakPhysicalFootprint(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('peak physical footprint requires exact raw bytes without rounding or hiding a valid value', () => {
  const s = row();
  for (const change of [{ bytes: -1 }, { bytes: .5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawBytes: '4097' }, { rawBytes: '04096' }, { rawBytes: null }, { rawBytes: '9223372036854775808' },
    { bytes: null, error: 'failed' }, { error: 'failed' }])
    assert.throws(() => validatePeakPhysicalFootprint({ ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, ...change } }));
  for (const rawBytes of ['9007199254740992', '9223372036854775807']) {
    const imprecise = { ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, bytes: null, rawBytes, error: 'Exceeds exact JS integer range' } };
    assert.equal(validatePeakPhysicalFootprint(imprecise).rawBytes, rawBytes);
  }
});
test('peak physical footprint requires lifetime scope, exact source, byte units and environment', () => {
  const s = row();
  for (const change of [{ scope: 'device' }, { unit: 'pages' }, { environment: 'unknown' }, { source: 'task_info(TASK_VM_INFO).phys_footprint' }])
    assert.throws(() => validatePeakPhysicalFootprint({ ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, ...change } }));
  assert.equal(validatePeakPhysicalFootprint({ ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, environment: 'device' } }).environment, 'device');
});
test('peak physical footprint rejects wrong platform, clock and sample identity', () => {
  for (const change of [{ platform: 'android' }, { sequence: 0 }, { processId: 0 }, { clockSource: 'Date.now' },
    { queryFinishedUptimeMs: 999 }, { queryStartedUptimeMs: NaN }, { monotonicMs: 999 }, { osVersion: '' }])
    assert.throws(() => validatePeakPhysicalFootprint({ ...row(), ...change }));
});

test('signed Mach errors retain exact raw values without becoming unsigned memory', () => {
  const s = row();
  for (const rawBytes of ['-1', '-9223372036854775808']) {
    const failed = { ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, bytes: null, rawBytes, error: 'Negative Mach peak physical footprint' } };
    assert.equal(validatePeakPhysicalFootprint(failed).rawBytes, rawBytes);
    assert.throws(() => validatePeakPhysicalFootprint({ ...failed, peakPhysicalFootprint: { ...failed.peakPhysicalFootprint, bytes: 0, error: null } }));
  }
  for (const rawBytes of ['-0', '-01', '-9223372036854775809', '1.5', '+1'])
    assert.throws(() => validatePeakPhysicalFootprint({ ...s, peakPhysicalFootprint: { ...s.peakPhysicalFootprint, bytes: null, rawBytes, error: 'Invalid' } }));
});
test('peak stays independent of current-footprint availability and is never clamped', () => {
  const s = row(4096);
  assert.equal(validatePeakPhysicalFootprint(s).bytes, 4096);
  s.physicalFootprint = { ...s.physicalFootprint, bytes: null, error: 'Unavailable' };
  assert.equal(validatePeakPhysicalFootprint(s).bytes, 4096);
});

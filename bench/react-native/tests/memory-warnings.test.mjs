import assert from 'node:assert/strict';
import test from 'node:test';
import {MemoryWarningTracker, validateMemoryWarningSnapshot} from '../src/memoryWarnings.ts';

const sample = (count = 0, extra = {}) => ({
  source: 'UIApplication.didReceiveMemoryWarningNotification', scope: 'warnings_delivered_to_app',
  platform: 'ios', osVersion: '18.0', environment: 'simulator', clockSource: 'NSProcessInfo.systemUptime',
  processId: 123, observationId: '11111111-1111-4111-8111-111111111111',
  observationStartedAtMs: 1800000000000, observationStartedUptimeMs: 1000,
  warningCount: count, lastWarning: count ? {sequence: count, receivedAtMs: 1800000001000 + count,
    receivedUptimeMs: 1500 + count, applicationState: 'active'} : null,
  snapshotAtMs: 1800000002000, snapshotUptimeMs: 2000, ...extra,
});

test('zero is an observed count; missing data, inferred states and malformed receipts are rejected', () => {
  assert.equal(validateMemoryWarningSnapshot(sample()).warningCount, 0);
  assert.equal(validateMemoryWarningSnapshot(sample(1)).lastWarning.sequence, 1);
  for (const bad of [null, {}, sample(0, {lastWarning: undefined}), sample(0, {lastWarning: sample(1).lastWarning}),
    sample(1, {lastWarning: null}), sample(-1), sample(0.5), sample(Number.MAX_SAFE_INTEGER + 1),
    sample(1, {source: 'derived from RSS'}), sample(1, {scope: 'system_state'}),
    sample(1, {platform: 'android'}), sample(1, {observationId: ''}),
    sample(1, {lastWarning: {...sample(1).lastWarning, receivedUptimeMs: 999}}),
    sample(1, {lastWarning: {...sample(1).lastWarning, receivedUptimeMs: 2001}}),
    sample(1, {lastWarning: {...sample(1).lastWarning, sequence: 2}}),
    sample(1, {lastWarning: {...sample(1).lastWarning, applicationState: 'memory normal'}})])
    assert.throws(() => validateMemoryWarningSnapshot(bad));
});

test('a delayed initial read cannot erase a warning delivered after subscription', () => {
  const tracker = new MemoryWarningTracker();
  const warning = tracker.record(sample(1, {snapshotUptimeMs: 2200}));
  assert.deepEqual(tracker.record(sample(0)), warning);
  assert.deepEqual(tracker.record({...warning, lastWarning: {applicationState: 'active', receivedUptimeMs: 1501,
    sequence: 1, receivedAtMs: 1800000001001}}), warning);
  assert.throws(() => tracker.record(sample(0, {snapshotUptimeMs: 2300})), /regressed/);
});

test('resume reconciles cumulative count without fabricating missing event receipts', () => {
  const tracker = new MemoryWarningTracker();
  tracker.record(sample(1));
  const resumed = tracker.record(sample(4, {snapshotUptimeMs: 2400,
    lastWarning: {...sample(4).lastWarning, applicationState: 'background'}}));
  assert.equal(resumed.warningCount, 4);
  assert.equal(resumed.lastWarning.sequence, 4);
  assert.equal(resumed.lastWarning.applicationState, 'background');
  assert.throws(() => tracker.record(sample(4, {snapshotUptimeMs: 2500})), /regressed/);
});

test('native observation survives repeated reads, and a new launch can legitimately reset to zero', () => {
  const tracker = new MemoryWarningTracker();
  tracker.record(sample(2));
  assert.equal(tracker.record(sample(2, {snapshotUptimeMs: 3000})).warningCount, 2);
  assert.throws(() => tracker.record(sample(2, {processId: 456, snapshotUptimeMs: 4000})), /identity/);
  const relaunched = sample(0, {processId: 456, observationId: '22222222-2222-4222-8222-222222222222',
    observationStartedUptimeMs: 5000, snapshotUptimeMs: 6000});
  assert.equal(tracker.record(relaunched).warningCount, 0);
});

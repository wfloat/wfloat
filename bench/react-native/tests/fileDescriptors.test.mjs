import assert from 'node:assert/strict';
import test from 'node:test';
import { FileDescriptorTracker, validateFileDescriptorSample } from '../src/fileDescriptors.ts';

const row = (overrides = {}) => ({
  platform: 'android', source: '/proc/self/fd', scope: 'calling_process', unit: 'descriptors', atomicSnapshot: false,
  count: 70, availability: 'available', reason: null, excludedCollectorDescriptor: 50,
  processId: 100, observationId: 'collection-a', sequence: 1, clockSource: 'SystemClock.elapsedRealtimeNanos',
  queryStartedUptimeMs: 100, queryFinishedUptimeMs: 101, sampledAtMs: 1700000000000,
  osVersion: '16', apiLevel: 36, buildFingerprint: 'test', debugBuild: false, ...overrides,
});
test('FD gauge accepts its first reading, decreases and zero', () => {
  const tracker = new FileDescriptorTracker();
  assert.equal(tracker.record(row()).count, 70);
  assert.equal(tracker.record(row({ count: 0, sequence: 2, queryStartedUptimeMs: 200, queryFinishedUptimeMs: 201 })).count, 0);
});
test('FD read failures retain a reason and no numeric reading', () => {
  const s = validateFileDescriptorSample(row({ count: null, excludedCollectorDescriptor: null, availability: 'error', reason: 'Permission denied' }));
  assert.equal(s.count, null);
  for (const change of [{ count: 0 }, { reason: null }, { excludedCollectorDescriptor: 1 }])
    assert.throws(() => validateFileDescriptorSample({ ...s, ...change }));
});
test('FD count and self-exclusion must be nonnegative native integers', () => {
  for (const key of ['count', 'excludedCollectorDescriptor'])
    for (const n of [null, -1, 0.1, NaN, Infinity, '4', 2147483648])
      assert.throws(() => validateFileDescriptorSample(row({ [key]: n })));
  assert.throws(() => validateFileDescriptorSample(row({ reason: 'failed' })));
  assert.throws(() => validateFileDescriptorSample(row({ availability: 'unsupported' })));
});
test('FD readings reject altered scope, source and invalid timing', () => {
  for (const change of [{ source: '/proc/self/status:FDSize' }, { scope: 'device' }, { unit: 'bytes' },
    { atomicSnapshot: true }, { queryFinishedUptimeMs: 99 }, { queryStartedUptimeMs: NaN },
    { observationId: '' }, { processId: 0 }, { apiLevel: 23 }, { sampledAtMs: 0 }])
    assert.throws(() => validateFileDescriptorSample(row(change)));
});
test('FD ordering rejects old or overlapping queries within an observation', () => {
  for (const change of [{ sequence: 1 }, { queryStartedUptimeMs: 100.5 }]) {
    const tracker = new FileDescriptorTracker(); tracker.record(row());
    assert.throws(() => tracker.record(row({ sequence: 2, queryStartedUptimeMs: 200, queryFinishedUptimeMs: 201, ...change })));
  }
});
test('FD gauge accepts a new observation or an explicit resume reset', () => {
  const tracker = new FileDescriptorTracker(); tracker.record(row());
  assert.equal(tracker.record(row({ observationId: 'collection-b', count: 42 })).count, 42);
  tracker.reset(); assert.equal(tracker.record(row()).count, 70);
});

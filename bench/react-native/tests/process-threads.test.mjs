import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadTracker, validateThreadSample } from '../src/processThreads.ts';

const sample = (overrides = {}) => ({ platform: 'android', threadCount: 42,
  source: '/proc/self/status:Threads', clockSource: 'SystemClock.elapsedRealtimeNanos',
  queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1001, sampledAtMs: 1700000000000,
  processId: 123, sequence: 1, osVersion: '16', apiLevel: 36, ...overrides });

test('thread count is an immediate gauge that can decrease', () => {
  const tracker = new ThreadTracker();
  assert.equal(tracker.record(sample()).threadCount, 42);
  assert.equal(tracker.record(sample({threadCount: 30, sequence: 2,
    queryStartedUptimeMs: 3000, queryFinishedUptimeMs: 3001})).threadCount, 30);
  assert.equal(validateThreadSample(sample({platform: 'ios', source: 'task_threads(mach_task_self()):count',
    clockSource: 'NSProcessInfo.systemUptime', apiLevel: undefined})).threadCount, 42);
});

test('missing, zero, malformed and incorrectly sourced counts never become valid readings', () => {
  for (const value of [undefined, null, {}, sample({threadCount: 0}), sample({threadCount: -1}),
    sample({threadCount: 1.5}), sample({threadCount: '42'}), sample({threadCount: 2 ** 32}),
    sample({queryFinishedUptimeMs: 999}), sample({queryStartedUptimeMs: NaN}),
    sample({source: 'Thread.activeCount()'}), sample({clockSource: 'wall clock'}),
    sample({apiLevel: undefined}), sample({sampledAtMs: Infinity}), sample({processId: 0})])
    assert.throws(() => validateThreadSample(value));
});

test('rejects duplicate and overlapping samples; resets permit a fresh reading after interruption', () => {
  const tracker = new ThreadTracker();
  tracker.record(sample());
  assert.throws(() => tracker.record(sample()), /out of order/);
  tracker.record(sample());
  assert.throws(() => tracker.record(sample({sequence: 2, queryStartedUptimeMs: 1000.5})), /out of order/);
  tracker.record(sample());
  tracker.reset();
  assert.equal(tracker.record(sample()).threadCount, 42);
  assert.equal(tracker.record(sample({processId: 456})).processId, 456);
});

test('keeps bounded raw sample history without inventing a lifetime peak', () => {
  const tracker = new ThreadTracker();
  for (let i = 1; i <= 140; i++) tracker.record(sample({sequence: i,
    queryStartedUptimeMs: i * 2000, queryFinishedUptimeMs: i * 2000 + 1}));
  assert.equal(tracker.samples.length, 120);
  assert.equal(tracker.samples[0].sequence, 21);
});

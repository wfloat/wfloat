import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessCpuTracker, validateProcessCpuSample } from '../src/processCpu.ts';

const sample = (userMs, systemMs, monotonicMs, extra = {}) => ({
  userCpuTimeUs: Math.round(userMs * 1000), systemCpuTimeUs: Math.round(systemMs * 1000),
  cpuTimeMs: (Math.round(userMs * 1000) + Math.round(systemMs * 1000)) / 1000,
  queryStartedUptimeMs: monotonicMs, queryFinishedUptimeMs: monotonicMs, monotonicMs,
  sampledAtMs: 1800000000000 + monotonicMs, processId: 123, sequence: monotonicMs + 1,
  source: 'getrusage(RUSAGE_SELF):ru_utime,ru_stime', clockSource: 'SystemClock.elapsedRealtimeNanos',
  platform: 'android', osVersion: '16', apiLevel: 36, ...extra,
});

test('multicore components and total use the same actual elapsed interval', () => {
  const tracker = new ProcessCpuTracker();
  const first = sample(100, 20, 500), next = sample(6100, 270, 3000);
  assert.equal(tracker.record(first), null);
  const usage = tracker.record(next);
  assert.equal(usage.elapsedMs, 2500);
  assert.equal(usage.userDeltaMs, 6000);
  assert.equal(usage.systemDeltaMs, 250);
  assert.equal(usage.cpuDeltaMs, 6250);
  assert.equal(usage.userPercent, 240);
  assert.equal(usage.systemPercent, 10);
  assert.equal(usage.percent, 250);
  assert.equal(usage.previous, first);
  assert.equal(usage.current, next);
});

test('wall-clock changes do not affect CPU use; unchanged components are valid zero', () => {
  const tracker = new ProcessCpuTracker();
  tracker.record(sample(80, 20, 1000));
  const usage = tracker.record(sample(580, 20, 2000, {sampledAtMs: 42}));
  assert.equal(usage.userPercent, 50);
  assert.equal(usage.systemPercent, 0);
  assert.equal(usage.percent, 50);
  const zero = tracker.record(sample(580, 20, 3000));
  assert.equal(zero.userPercent, 0);
  assert.equal(zero.systemPercent, 0);
  assert.equal(zero.percent, 0);
});

test('foreground resets and process/platform changes require a fresh pair', () => {
  const tracker = new ProcessCpuTracker();
  tracker.record(sample(80, 20, 1000));
  tracker.resetWindow();
  assert.equal(tracker.record(sample(580, 20, 60000)), null);
  assert.equal(tracker.record(sample(680, 20, 61000)).percent, 10);
  assert.equal(tracker.record(sample(0, 0, 62000, {processId: 456})), null);
  assert.equal(tracker.record(sample(500, 0, 63000, {processId: 456})).percent, 50);
  assert.equal(tracker.record(sample(600, 0, 64000, {platform: 'ios',
    clockSource: 'NSProcessInfo.systemUptime', apiLevel: undefined, osVersion: '18.0'})), null);
});

test('missing splits, invalid totals, wrong sources and exhausted counters reject', () => {
  for (const invalid of [null, {}, sample(-1, 1, 2000), sample(NaN, 0, 2000), sample(1, 0, Infinity),
    sample(1, 0, 1, {processId: 0}), sample(1, 0, 1, {systemCpuTimeUs: undefined}),
    sample(1, 1, 1, {cpuTimeMs: 1}), sample(1, 0, 1, {userCpuTimeUs: 1.5}),
    sample(1, 0, 1, {source: 'Process.getElapsedCpuTime()'}), sample(1, 0, 1, {apiLevel: undefined}),
    sample(1, 0, 1, {userCpuTimeUs: Number.MAX_SAFE_INTEGER, systemCpuTimeUs: 1})])
    assert.throws(() => validateProcessCpuSample(invalid), /Invalid/);
});

test('each component must be monotonic even when the total rises; failures reset the pair', () => {
  for (const invalid of [sample(79, 30, 2000), sample(90, 19, 2000), sample(200, 20, 1000),
    sample(200, 20, 500), sample(200, 20, 2000, {sequence: 1001})]) {
    const tracker = new ProcessCpuTracker();
    tracker.record(sample(80, 20, 1000));
    assert.throws(() => tracker.record(invalid), /counter or monotonic clock/);
    assert.equal(tracker.record(sample(300, 30, 3000)), null);
  }
});

test('query bounds constrain sample times and prevent overlapping windows', () => {
  const first = sample(80, 20, 1010, {queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1020});
  const tracker = new ProcessCpuTracker();
  tracker.record(first);
  assert.throws(() => validateProcessCpuSample({...first, monotonicMs: 1009}));
  assert.throws(() => tracker.record(sample(90, 25, 1020, {queryStartedUptimeMs: 1015,
    queryFinishedUptimeMs: 1025})), /out of order/);
});

test('microsecond deltas remain exact when cumulative counters are large', () => {
  const tracker = new ProcessCpuTracker();
  const base = sample(0, 0, 1000, {userCpuTimeUs: 4000000000000000, systemCpuTimeUs: 1000000000000000,
    cpuTimeMs: 5000000000000});
  tracker.record(base);
  const usage = tracker.record({...base, userCpuTimeUs: base.userCpuTimeUs + 1,
    systemCpuTimeUs: base.systemCpuTimeUs + 2, cpuTimeMs: (5000000000000003) / 1000,
    sequence: 2001, monotonicMs: 2000, queryStartedUptimeMs: 2000, queryFinishedUptimeMs: 2000});
  assert.equal(usage.userDeltaMs, 0.001);
  assert.equal(usage.systemDeltaMs, 0.002);
  assert.equal(usage.cpuDeltaMs, 0.003);
});

test('raw sample retention stays bounded', () => {
  const tracker = new ProcessCpuTracker();
  for (let i = 0; i < 140; i++) tracker.record(sample(i * 400, i * 100, i * 1000));
  assert.equal(tracker.samples.length, 120);
  assert.equal(tracker.samples[0].cpuTimeMs, 10000);
  assert.equal(tracker.record(sample(56000, 14000, 140000)).percent, 50);
});

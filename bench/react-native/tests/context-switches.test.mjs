import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextSwitchTracker, validateContextSwitchSample } from '../src/contextSwitches.ts';
const sample = (overrides = {}) => ({ platform: 'android',
  counters: {total: 120, voluntary: 100, involuntary: 20},
  source: 'getrusage(RUSAGE_SELF):ru_nvcsw,ru_nivcsw', clockSource: 'SystemClock.elapsedRealtimeNanos',
  queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, sampledAtMs: 1700000000000,
  processId: 123, sequence: 1, osVersion: '16', apiLevel: 36,
  probe: {running: false, wakes: 0, elapsedMs: 0, runSequence: 0}, ...overrides });
const next = (overrides = {}) => sample({sequence: 2, queryStartedUptimeMs: 3500, queryFinishedUptimeMs: 3502, ...overrides});
const ios = (overrides = {}) => sample({platform: 'ios', counters: {total: 120},
  source: 'task_info(TASK_EVENTS_INFO):csw', clockSource: 'NSProcessInfo.systemUptime', apiLevel: undefined, ...overrides});

test('Android components share the same actual native interval and sum to the total', () => {
  const t = new ContextSwitchTracker();
  assert.equal(t.record(sample()).rate, null);
  const {rate} = t.record(next({counters: {total: 420, voluntary: 350, involuntary: 70}, sampledAtMs: 1}));
  assert.equal(rate.elapsedMs, 2500); assert.equal(rate.delta, 300); assert.equal(rate.perSecond, 120);
  assert.equal(rate.voluntaryPerSecond, 100); assert.equal(rate.involuntaryPerSecond, 20);
  assert.equal(rate.previous.counters.total, 120);
});
test('iOS preserves its own total without inventing an Android breakdown; unchanged counts are zero', () => {
  const t = new ContextSwitchTracker(); t.record(ios());
  const {rate} = t.record(ios({sequence: 2, queryStartedUptimeMs: 3000, queryFinishedUptimeMs: 3002}));
  assert.equal(rate.perSecond, 0); assert.equal(rate.voluntaryDelta, undefined); assert.equal(rate.involuntaryDelta, undefined);
});
test('malformed, mislabelled, exhausted and inconsistent counters never become zero rates', () => {
  for (const value of [null, {}, sample({counters: {total: 1}}), sample({counters: {total: 121, voluntary: 100, involuntary: 20}}),
    sample({counters: {total: 2 ** 53, voluntary: 2 ** 53, involuntary: 0}}), sample({source: 'proc/thread/stat'}),
    sample({clockSource: 'wall clock'}), sample({queryFinishedUptimeMs: 999}), sample({sampledAtMs: NaN}),
    sample({sequence: 0}), sample({processId: 0}), sample({apiLevel: undefined}), sample({probe: null}),
    ios({counters: {total: 2147483647}}), ios({counters: {total: -1}}), ios({counters: {total: 120, voluntary: 0}})])
    assert.throws(() => validateContextSwitchSample(value));
});
test('rejects each component decreasing even when the total increases, and resets after failure', () => {
  for (const counters of [{total: 200, voluntary: 90, involuntary: 110}, {total: 200, voluntary: 190, involuntary: 10}]) {
    const t = new ContextSwitchTracker(); t.record(sample());
    assert.throws(() => t.record(next({counters})), /backwards/);
    assert.equal(t.record(next()).rate, null);
  }
});
test('rejects duplicates, overlap and total regression; foreground and identity changes need fresh pairs', () => {
  for (const bad of [sample(), next({queryStartedUptimeMs: 1001}), next({counters: {total: 0, voluntary: 0, involuntary: 0}})]) {
    const t = new ContextSwitchTracker(); t.record(sample()); assert.throws(() => t.record(bad));
  }
  const t = new ContextSwitchTracker(); t.record(sample()); t.resetWindow();
  assert.equal(t.record(next()).rate, null);
  assert.equal(t.record(sample({processId: 456})).rate, null);
  assert.equal(t.record(ios()).rate, null);
});
test('large cumulative counters retain one-event changes and raw history remains bounded', () => {
  const t = new ContextSwitchTracker(), base = Number.MAX_SAFE_INTEGER - 1000;
  for (let i = 0; i < 140; i++) {
    const r = t.record(sample({sequence: i + 1, queryStartedUptimeMs: i * 2000, queryFinishedUptimeMs: i * 2000 + 1,
      counters: {total: base + i, voluntary: base + i, involuntary: 0}}));
    if (i) assert.equal(r.rate.perSecond, 0.5);
  }
  assert.equal(t.samples.length, 120); assert.equal(t.samples[0].sequence, 21);
});

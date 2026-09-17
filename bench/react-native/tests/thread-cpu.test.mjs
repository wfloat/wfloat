import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadCpuTracker, validateThreadCpuSample } from '../src/threadCpu.ts';

function sample(sequence = 1, t = 1000, threads = [thread()]) {
  return { platform: 'android', source: '/proc/self/task/*/stat:utime,stime,starttime',
    clockSource: 'SystemClock.elapsedRealtimeNanos', counterUnit: 'clock_ticks', counterUnitsPerSecond: 100,
    processId: 123, sequence, osVersion: '16', apiLevel: 36, sampledAtMs: 1700000000000 + t,
    queryStartedUptimeMs: t, queryFinishedUptimeMs: t + 10, enumeratedThreadCount: threads.length,
    threads: threads.map((r, i) => ({ ...r, queryStartedUptimeMs: t + i, queryFinishedUptimeMs: t + i + 0.5 })), errors: [] };
}
function thread(id = '1', user = 50, system = 10, start = '100') {
  return { threadId: id, startTimeTicks: start, name: 'worker', userTime: user, systemTime: system };
}
test('individual cumulative counters yield user/kernel CPU intervals with one core as 100%', () => {
  const tracker = new ThreadCpuTracker();
  assert.equal(tracker.record(sample()).rows[0].percent, null);
  const row = tracker.record(sample(2, 3000, [thread('1', 200, 60)])).rows[0];
  assert.equal(row.userDeltaMs, 1500); assert.equal(row.systemDeltaMs, 500);
  assert.equal(row.elapsedMs, 2000); assert.equal(row.percent, 100);
  assert.equal(tracker.record(sample(3, 5000, [thread('1', 200, 60)])).rows[0].percent, 0);
});
test('rank busy threads independently, using each read midpoint rather than a whole-scan clock', () => {
  const tracker = new ThreadCpuTracker();
  tracker.record(sample(1, 1000, [thread('1'), thread('2')]));
  const s = sample(2, 3000, [thread('2', 100), thread('1', 250)]);
  const rows = tracker.record(s).rows;
  assert.equal(rows[0].reading.threadId, '1');
  assert.equal(rows[0].elapsedMs, 2001); assert.equal(rows[1].elapsedMs, 1999);
  assert.equal(rows[0].percent, 100 * 2000 / 2001);
});
test('new, missing, reused and reset threads cannot manufacture CPU time', () => {
  const tracker = new ThreadCpuTracker();
  tracker.record(sample());
  assert.equal(tracker.record(sample(2, 3000, [thread('1', 900, 50, '101')])).rows[0].percent, null);
  assert.equal(tracker.record(sample(3, 5000, [thread('1', 1, 0, '101')])).rows[0].state, 'counter_reset');
  assert.equal(tracker.record(sample(4, 7000, [thread('1', 101, 0, '101')])).rows[0].percent, 50);
  tracker.record({ ...sample(5, 9000, []), enumeratedThreadCount: 1, errors: [{ threadId: '1', reason: 'read_failed' }] });
  assert.equal(tracker.record(sample(6, 11000, [thread('1', 500, 0, '101')])).rows[0].percent, null);
  tracker.reset(); assert.equal(tracker.record(sample(7, 13000)).rows[0].percent, null);
  assert.equal(tracker.record({ ...sample(1, 14000), processId: 456 }).rows[0].percent, null);
});
test('iOS uses microseconds and exact 64-bit thread identity strings', () => {
  const ios = (seq, t, user) => ({ ...sample(seq, t, [thread('18446744073709551615', user, 100, null)]),
    platform: 'ios', source: 'thread_info(THREAD_BASIC_INFO,THREAD_IDENTIFIER_INFO)',
    counterUnit: 'microseconds', counterUnitsPerSecond: 1000000, clockSource: 'NSProcessInfo.systemUptime', apiLevel: undefined });
  const tracker = new ThreadCpuTracker(); tracker.record(ios(1, 1000, 0));
  assert.equal(tracker.record(ios(2, 3000, 1500000)).rows[0].percent, 75);
});
test('malformed identities, counters, missing records and clocks fail explicitly', () => {
  const s = sample();
  for (const changed of [{ enumeratedThreadCount: 2 }, { counterUnitsPerSecond: 0 },
    { threads: [{ ...s.threads[0], userTime: -1 }] },
    { threads: [{ ...s.threads[0], systemTime: Number.MAX_SAFE_INTEGER }] },
    { threads: [{ ...s.threads[0], threadId: '18446744073709551616' }] },
    { threads: [{ ...s.threads[0], startTimeTicks: null }] },
    { threads: [{ ...s.threads[0], queryFinishedUptimeMs: 2000 }] },
    { enumeratedThreadCount: 2, threads: [s.threads[0], s.threads[0]] },
    { errors: [{ threadId: '1', reason: 'failed' }], enumeratedThreadCount: 2 }]) {
    assert.throws(() => validateThreadCpuSample({ ...s, ...changed }));
  }
  const tracker = new ThreadCpuTracker(); tracker.record(s);
  assert.throws(() => tracker.record(s));
  assert.equal(tracker.record(sample(2, 3000)).rows[0].percent, null);
});

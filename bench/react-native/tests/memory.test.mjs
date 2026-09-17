import assert from "node:assert/strict";
import test from "node:test";
import { mebibytes, PeakRssTracker, validateMemoryCounter, validateMemorySample } from "../src/memory.ts";

const sample = (extra = {}) => ({
  rssBytes: 160 * 1024 * 1024, heldBytes: 0, source: "native RSS",
  processId: 123, sampledAtMs: 1800000000000, monotonicMs: 5000,
  readDurationMs: 0.4, ...extra,
});

const peakSample = (bytes, extra = {}) => sample({platform: 'android', osVersion: '16', apiLevel: 36,
  sequence: 1, queryStartedUptimeMs: 4999, queryFinishedUptimeMs: 5001,
  clockSource: 'SystemClock.elapsedRealtimeNanos',
  peakRss: {bytes, scope: 'process_lifetime', source: 'getrusage(RUSAGE_SELF).ru_maxrss', error: null}, ...extra});
const later = (bytes, extra = {}) => peakSample(bytes, {sequence: 2, monotonicMs: 7000,
  queryStartedUptimeMs: 6999, queryFinishedUptimeMs: 7001, ...extra});

test('peak RSS comes from the OS, persists after release, and can be lower than separately accounted current RSS', () => {
  const tracker = new PeakRssTracker();
  assert.equal(tracker.record(peakSample(100), 'android').bytes, 100);
  assert.equal(tracker.record(later(200, {rssBytes: 50, heldBytes: 0}), 'android').bytes, 200);
  assert.equal(tracker.record(later(200, {sequence: 3, monotonicMs: 9000, queryStartedUptimeMs: 8999, queryFinishedUptimeMs: 9001}), 'android').bytes, 200);
  // A genuinely new process may have a smaller lifetime peak.
  assert.equal(tracker.record(peakSample(20, {processId: 456}), 'android').bytes, 20);
});

test('peak failure stays separate from RSS and cannot silently reset an established OS peak', () => {
  const tracker = new PeakRssTracker(); tracker.record(peakSample(200), 'android');
  const unavailable = later(null);
  unavailable.peakRss.error = 'Native peak unavailable';
  assert.equal(tracker.record(unavailable, 'android').bytes, null);
  assert.equal(validateMemorySample(unavailable).rssBytes, 160 * 1024 * 1024);
  assert.throws(() => tracker.record(later(100, {sequence: 3}), 'android'), /decreased/);
  assert.equal(tracker.record(later(250, {sequence: 4}), 'android').bytes, 250);
});

test('peak source, scope, identity, order and integer precision must be valid', () => {
  const base = peakSample(100);
  for (const bad of [peakSample(-1), peakSample(0.5), peakSample(Number.MAX_SAFE_INTEGER + 1),
    peakSample(100, {peakRss: undefined}), peakSample(100, {sequence: 0}), peakSample(100, {platform: 'ios'}),
    peakSample(100, {queryFinishedUptimeMs: 4000}), peakSample(100, {apiLevel: undefined}),
    peakSample(100, {peakRss: {...base.peakRss, scope: 'benchmark_run'}}),
    peakSample(100, {peakRss: {...base.peakRss, source: 'max(sampled RSS)'}})])
    assert.throws(() => new PeakRssTracker().record(bad, 'android'));
  const tracker = new PeakRssTracker(); tracker.record(base, 'android');
  assert.throws(() => tracker.record(base, 'android'), /out of order/);
  assert.throws(() => tracker.record(later(100, {queryStartedUptimeMs: 5000}), 'android'), /out of order/);
  const ios = peakSample(100, {platform: 'ios', osVersion: '18.0', apiLevel: undefined,
    clockSource: 'NSProcessInfo.systemUptime', peakRss: {...base.peakRss, source: 'task_info(TASK_VM_INFO).resident_size_peak'}});
  assert.equal(new PeakRssTracker().record(ios, 'ios').bytes, 100);
});

test("PSS and footprint retain separate sources and explicit unavailable states", () => {
  for (const [name, source] of [["PSS", "/proc/self/smaps_rollup:Pss"], ["physical footprint", "task_info(TASK_VM_INFO).phys_footprint"]]) {
    const available = { bytes: 0, source, error: null };
    const unavailable = { bytes: null, source, error: "Access denied" };
    assert.equal(validateMemoryCounter(available, name), available);
    assert.equal(validateMemoryCounter(unavailable, name), unavailable);
    assert.equal(validateMemorySample(sample({ pss: unavailable })).rssBytes, 160 * 1024 * 1024);
    for (const invalid of [undefined, {}, { ...available, bytes: -1 },
      { ...available, bytes: 0.5 }, { ...available, bytes: Infinity },
      { ...available, bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...available, source: "" },
      { ...available, error: "Failed" }, { ...unavailable, error: null },
      { ...unavailable, error: " " }]) {
      assert.throws(() => validateMemoryCounter(invalid, name), /Invalid native/);
    }
  }
});

test("RSS uses binary MiB and preserves native provenance and timing", () => {
  const reading = sample();
  assert.equal(mebibytes(reading.rssBytes), "160.0");
  assert.equal(mebibytes(64 * 1024 * 1024), "64.0");
  assert.equal(mebibytes(1_000_000), "1.0");
  assert.equal(validateMemorySample(reading), reading);
  assert.equal(validateMemorySample(sample({ rssBytes: 0 })).rssBytes, 0);
});

test("missing, malformed or imprecise readings fail instead of becoming zero", () => {
  for (const invalid of [
    null, {}, sample({ rssBytes: -1 }), sample({ rssBytes: NaN }),
    sample({ rssBytes: Number.MAX_SAFE_INTEGER + 1 }), sample({ heldBytes: 1.5 }),
    sample({ processId: 0 }), sample({ source: " " }), sample({ source: 42 }),
    sample({ monotonicMs: Infinity }), sample({ readDurationMs: -0.1 }),
  ]) assert.throws(() => validateMemorySample(invalid), /Invalid native RSS/);
});

test('iOS headroom is a changing app allowance and preserves ambiguous zero and simulator provenance', async () => {
  const { validateMemoryHeadroom } = await import('../src/memory.ts');
  const row = (bytes) => sample({platform: 'ios', osVersion: '18.0', sequence: 1,
    clockSource: 'NSProcessInfo.systemUptime', queryStartedUptimeMs: 4999, queryFinishedUptimeMs: 5001,
    headroom: {bytes, rawBytes: String(bytes), source: 'os_proc_available_memory()', error: null,
      scope: 'current_app_limit', environment: 'simulator'}});
  for (const bytes of [1024, 64, 2048, 0]) {
    const reading = validateMemoryHeadroom(row(bytes));
    assert.equal(reading.bytes, bytes);
    assert.equal(reading.environment, 'simulator');
  }
  const base = row(1024);
  for (const changes of [{platform: 'android'}, {headroom: undefined}, {sequence: 0},
    {queryFinishedUptimeMs: 4000}, {headroom: {...base.headroom, bytes: -1}},
    {headroom: {...base.headroom, rawBytes: '1025'}}, {headroom: {...base.headroom, rawBytes: '01'}},
    {headroom: {...base.headroom, environment: 'unknown'}},
    {headroom: {...base.headroom, scope: 'total_device_ram'}},
    {headroom: {...base.headroom, source: 'free RAM'}}])
    assert.throws(() => validateMemoryHeadroom({...base, ...changes}));
  const unavailable = {...base, headroom: {...base.headroom, bytes: null,
    rawBytes: '18446744073709551615', error: 'Memory headroom exceeds exact JavaScript integer range'}};
  assert.equal(validateMemoryHeadroom(unavailable).bytes, null);
  assert.equal(validateMemorySample(unavailable).rssBytes, base.rssBytes);
  assert.throws(() => validateMemoryHeadroom({...unavailable, headroom: {...unavailable.headroom, rawBytes: '0'}}));
});

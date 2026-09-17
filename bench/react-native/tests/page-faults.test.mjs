import assert from "node:assert/strict";
import test from "node:test";
import { PageFaultTracker } from "../src/pageFaults.ts";

const sample = (sequence, uptime, minorFaults, majorFaults, extra = {}) => ({
  kind: "android_minor_major", counters: { minorFaults, majorFaults },
  source: "getrusage", pageSizeBytes: 4096, queryStartedUptimeMs: uptime,
  queryFinishedUptimeMs: uptime + 2, sampledAtMs: 1800000000000 + uptime,
  processId: 123, sequence, osVersion: "16", ...extra,
});

test("delayed delivery and wall-clock changes do not change native interval rates", () => {
  const tracker = new PageFaultTracker();
  const first = sample(1, 1000, 100, 10);
  assert.equal(tracker.record(first).window, null);
  const current = sample(2, 3500, 5100, 15, { sampledAtMs: 42 });
  const { window } = tracker.record(current);
  assert.equal(window.elapsedMs, 2500);
  assert.deepEqual(window.perSecond, { minorFaults: 2000, majorFaults: 2 });
  assert.equal(window.previous, first);
  assert.equal(window.current, current);
  assert.deepEqual(tracker.record(sample(3, 5500, 5100, 15)).window.perSecond,
    { minorFaults: 0, majorFaults: 0 });
});

test("resume and changed process or counter definitions require a new pair", () => {
  const tracker = new PageFaultTracker();
  tracker.record(sample(1, 1000, 100, 10));
  tracker.resetWindow();
  assert.equal(tracker.record(sample(2, 60000, 10000, 50)).window, null);
  assert.equal(tracker.record(sample(1, 62000, 5, 0, { processId: 456 })).window, null);
  assert.equal(tracker.record(sample(2, 64000, 0, 0, { processId: 456,
    kind: "ios_vm_events", counters: { vmFaults: 50, pageIns: 5 }, source: "Mach" })).window, null);
  const { window } = tracker.record(sample(3, 66000, 0, 0, { processId: 456,
    kind: "ios_vm_events", counters: { vmFaults: 150, pageIns: 9 }, source: "Mach" }));
  assert.deepEqual(window.perSecond, { vmFaults: 50, pageIns: 2 });
});

test("counter rollback and duplicate/overlapping queries invalidate the window", () => {
  for (const next of [sample(2, 3000, 99, 10), sample(2, 3000, 100, 9),
    sample(1, 3000, 200, 10), sample(2, 1001, 200, 10)]) {
    const tracker = new PageFaultTracker();
    tracker.record(sample(1, 1000, 100, 10));
    assert.throws(() => tracker.record(next));
    assert.equal(tracker.record(sample(3, 5000, 300, 20)).window, null);
  }
});

test("missing, rounded or saturated counters fail instead of becoming zero", () => {
  for (const next of [null, {}, sample(1, 1000, -1, 0), sample(1, 1000, 1.5, 0),
    sample(1, 1000, 2 ** 53, 0), sample(1, NaN, 1, 0),
    sample(1, 1000, 0, 0, { counters: { minorFaults: 1 } }),
    sample(1, 1000, 0, 0, { kind: "ios_vm_events", counters: { vmFaults: 2147483647, pageIns: 0 } })])
    assert.throws(() => new PageFaultTracker().record(next));
});

test("sample retention is bounded without resetting cumulative counts", () => {
  const tracker = new PageFaultTracker();
  for (let i = 1; i <= 140; i++) tracker.record(sample(i, i * 2000, i * 100, i));
  assert.equal(tracker.samples.length, 120);
  assert.equal(tracker.samples[0].sequence, 21);
  assert.deepEqual(tracker.record(sample(141, 282000, 14100, 141)).window.perSecond,
    { minorFaults: 50, majorFaults: 0.5 });
});

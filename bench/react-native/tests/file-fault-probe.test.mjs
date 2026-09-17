import assert from "node:assert/strict";
import test from "node:test";
import { validateFileFaultResult, fileFaultDeltas } from "../src/fileFaultProbe.ts";

function result(kind = "android_minor_major") {
  const keys = kind === "android_minor_major" ? ["minorFaults", "majorFaults"] : ["vmFaults", "pageIns"];
  const snapshot = (time, first, second) => ({ queryStartedUptimeMs: time, queryFinishedUptimeMs: time + 0.1,
    counters: { [keys[0]]: first, [keys[1]]: second } });
  return { status: "completed", stage: "finished", error: "", kind, source: "test process counters",
    processId: 123, runSequence: 1, fileBytes: 33554432, pageSizeBytes: 4096, startedAtMs: 1800000000000,
    startedUptimeMs: 100, finishedUptimeMs: 500, budgetMs: 30000, clockSource: "CLOCK_MONOTONIC",
    cacheOperation: "test advice", cacheResult: 0, randomAdviceResult: 0,
    passes: [
      { name: "first_read", before: snapshot(200, 10, 20), after: snapshot(300, 15, 120),
        readStartedUptimeMs: 201, readFinishedUptimeMs: 299, residentPagesBefore: 0,
        residencyErrno: 0, touchedPages: 8192, checksum: 5000 },
      { name: "reread", before: snapshot(310, 15, 120), after: snapshot(320, 15, 120),
        readStartedUptimeMs: 311, readFinishedUptimeMs: 319, residentPagesBefore: 8192,
        residencyErrno: 0, touchedPages: 8192, checksum: 5000 },
    ] };
}

test("probe retains distinct platform counters and valid zero reread deltas", () => {
  for (const kind of ["android_minor_major", "ios_vm_events"]) {
    const r = validateFileFaultResult(result(kind), kind);
    assert.deepEqual(Object.values(fileFaultDeltas(r.passes[0])), [5, 100]);
    assert.deepEqual(Object.values(fileFaultDeltas(r.passes[1])), [0, 0]);
  }
});
test("failed cache hints and unavailable residency do not manufacture a cold read", () => {
  const r = result(); r.cacheResult = 22;
  r.passes[0].residentPagesBefore = -1; r.passes[0].residencyErrno = 1;
  assert.equal(validateFileFaultResult(r, r.kind).cacheResult, 22);
  const cached = result();
  cached.passes[0].residentPagesBefore = 8192;
  cached.passes[0].after.counters = { ...cached.passes[0].before.counters };
  assert.deepEqual(Object.values(fileFaultDeltas(validateFileFaultResult(cached, cached.kind).passes[0])), [0, 0]);
});
test("early cancellation and partial completion remain separate from completed checks", () => {
  for (const status of ["cancelled", "deadline", "failed"]) {
    const r = result(); r.status = status; r.passes = []; r.pageSizeBytes = 0; r.cacheResult = -1;
    assert.equal(validateFileFaultResult(r, r.kind).status, status);
  }
  const partial = result(); partial.status = "cancelled"; partial.passes.pop();
  assert.equal(validateFileFaultResult(partial, partial.kind).passes.length, 1);
  partial.status = "completed";
  assert.throws(() => validateFileFaultResult(partial, partial.kind));
});
test("missing, decreasing, unverified and mistimed pass data fail validation", () => {
  const mutations = [
    r => { delete r.passes[0].before.counters.majorFaults; },
    r => { r.passes[0].after.counters.majorFaults = 19; },
    r => { r.passes[1].checksum++; },
    r => { r.passes[0].readFinishedUptimeMs = 301; },
    r => { r.passes[0].touchedPages--; },
    r => { r.passes[0].residentPagesBefore = 8193; },
    r => { r.passes[0].residencyErrno = 1; },
    r => { r.passes[0].before.counters.minorFaults = NaN; },
  ];
  for (const mutate of mutations) { const r = result(); mutate(r); assert.throws(() => validateFileFaultResult(r, r.kind)); }
});

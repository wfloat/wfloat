import assert from 'node:assert/strict';
import test from 'node:test';
import { CompressionRateTracker, MAX_COMPRESSION_INTERVAL_MS } from '../src/compressionRate.ts';

export const row = (total = 0n, sequence = 1, changes = {}) => ({
  platform:'ios', osVersion:'18.0', processId:123, sequence,
  sampledAtMs:1800000000000 + sequence * 2000, clockSource:'NSProcessInfo.systemUptime',
  monotonicMs:sequence * 2000 + 1, queryStartedUptimeMs:sequence * 2000,
  queryFinishedUptimeMs:sequence * 2000 + 2, readDurationMs:2,
  source:'task_info(MACH_TASK_BASIC_INFO).resident_size', rssBytes:16384, heldBytes:0,
  cumulativeCompressed:{bytes:total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null,
    rawBytes:String(total), source:'task_info(TASK_VM_INFO).compressed_lifetime',
    scope:'process_lifetime', unit:'bytes', accounting:'internal_compressed_ledger_credit_bytes', environment:'simulator',
    error:total <= BigInt(Number.MAX_SAFE_INTEGER) ? null : 'Cumulative compressed memory exceeds exact JavaScript integer range'},
  ...changes,
});

test('uses actual query midpoints, preserves zero, and exposes replayable interval provenance', () => {
  const t = new CompressionRateTracker();
  assert.equal(t.record(row()).status, 'baseline');
  assert.equal(t.record(row(0n,2)).rate.bytesPerSecond, 0);
  const s = row(20n * 1048576n,3); s.queryFinishedUptimeMs += 1000;
  const r = t.record(s);
  assert.equal(r.status,'measured'); assert.equal(r.rate.elapsedMs,2500);
  assert.equal(r.rate.bytesPerSecond,8 * 1048576);
  assert.equal(r.rate.rawDeltaBytes,'20971520');
  assert.equal(r.rate.fromSequence,2); assert.equal(r.rate.toSequence,3);
  assert.equal(r.rate.fromUptimeMs,4001); assert.equal(r.rate.toUptimeMs,6501);
  assert.equal(r.rate.processId,123);
  assert.equal(r.rate.source,'task_info(TASK_VM_INFO).compressed_lifetime');
});
test('subtracts large lifetime totals exactly before converting a small interval delta', () => {
  const t = new CompressionRateTracker(), base = 9007199254740992n;
  t.record(row(base));
  assert.equal(t.record(row(base + 1n,2)).rate.bytesPerSecond,.5);
  assert.equal(t.record(row(base + 4097n,3)).rate.deltaBytes,4096);
});
test('preserves unsigned maximum totals and rejects an inexact interval delta', () => {
  const t = new CompressionRateTracker(); t.record(row(0n));
  assert.equal(t.record(row(18446744073709551614n,2)).status,'unavailable');
  assert.equal(t.record(row(18446744073709551615n,3)).rate.deltaBytes,1);
  assert.throws(() => t.record(row(18446744073709551616n,4)));
  assert.equal(t.record(row(0n,5)).status,'baseline');
});
test('background reset, process change and environment changes cannot bridge intervals', () => {
  const t = new CompressionRateTracker(); t.record(row()); t.resetWindow();
  assert.equal(t.record(row(100n,2)).status,'baseline');
  assert.equal(t.record(row(200n,3)).rate.deltaBytes,100);
  assert.equal(t.record(row(1n,1,{processId:124})).status,'baseline');
  assert.equal(t.record(row(1n,2,{processId:124,osVersion:'19.0'})).status,'baseline');
  const device = row(2n,3,{processId:124,osVersion:'19.0'}); device.cumulativeCompressed.environment='device';
  assert.equal(t.record(device).status,'baseline');
});
test('missing sequence and long gaps discard that interval, then recover', () => {
  const t = new CompressionRateTracker(); t.record(row());
  assert.equal(t.record(row(20n,3)).status,'baseline');
  assert.equal(t.record(row(24n,4)).rate.deltaBytes,4);
  const delayed = row(40n,5,{queryStartedUptimeMs:20000,queryFinishedUptimeMs:20002,monotonicMs:20001});
  assert.equal(t.record(delayed).status,'baseline');
  const recovered = row(44n,6,{queryStartedUptimeMs:22000,queryFinishedUptimeMs:22002,monotonicMs:22001});
  assert.equal(t.record(recovered).rate.deltaBytes,4);
  const boundary = new CompressionRateTracker(); boundary.record(row());
  assert.equal(boundary.record(row(10n,2,{queryStartedUptimeMs:2000+MAX_COMPRESSION_INTERVAL_MS,
    queryFinishedUptimeMs:2002+MAX_COMPRESSION_INTERVAL_MS,monotonicMs:2001+MAX_COMPRESSION_INTERVAL_MS})).status,'measured');
});
test('unavailable and malformed samples clear the baseline without inventing inactivity', () => {
  const t = new CompressionRateTracker(); t.record(row());
  const unavailable = row(0n,2); unavailable.cumulativeCompressed={...unavailable.cumulativeCompressed,bytes:null,rawBytes:null,error:'Short Mach reply'};
  assert.equal(t.record(unavailable).status,'unavailable');
  assert.equal(t.record(row(100n,3)).status,'baseline');
  const missing = row(200n,4); delete missing.cumulativeCompressed;
  assert.throws(() => t.record(missing));
  assert.equal(t.record(row(300n,5)).status,'baseline');
});
test('decreases, duplicates, backwards sequences and overlapping queries fail and reset', () => {
  for (const s of [row(9n,2),row(10n,1),row(10n,0),row(11n,2,{queryStartedUptimeMs:2001,monotonicMs:2002})]) {
    const t = new CompressionRateTracker(); t.record(row(10n));
    assert.throws(() => t.record(s)); assert.equal(t.record(row(20n,3)).status,'baseline');
  }
});
test('snapshots the previous inputs and ignores wall-clock adjustments', () => {
  const t = new CompressionRateTracker(), first = row(100n); t.record(first);
  first.cumulativeCompressed.rawBytes='99999'; first.queryStartedUptimeMs=999999;
  const r=t.record(row(110n,2,{sampledAtMs:1}));
  assert.equal(r.rate.deltaBytes,10); assert.equal(r.rate.elapsedMs,2000);
});

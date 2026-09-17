import assert from 'node:assert/strict';
import test from 'node:test';
import { validateJavaHeapUsed, validateMemorySample } from '../src/memory.ts';
const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  javaHeapUsed: { bytes, rawBytes: String(bytes), source: 'Runtime.totalMemory() - Runtime.freeMemory()',
    scope: 'calling_process', unit: 'bytes', accounting: 'managed_heap_used_bytes', consistency: 'total_before_equals_total_after',
    rawTotalBeforeBytes: String(BigInt(bytes)+8192n), rawFreeBytes: '8192', rawTotalAfterBytes: String(BigInt(bytes)+8192n), error: null },
});
const withCounter = change => ({...row(), javaHeapUsed: {...row().javaHeapUsed, ...change}});
test('Java heap used accepts zero and rising/falling estimates independently of RSS', () => {
  for (const bytes of [0, 1048576, 4096, Number.MAX_SAFE_INTEGER]) assert.equal(validateJavaHeapUsed(row(bytes)).bytes, bytes);
});
test('Java heap verifies raw subtraction before numeric conversion', () => {
  const s = withCounter({rawTotalBeforeBytes:'9223372036854775807', rawTotalAfterBytes:'9223372036854775807', rawFreeBytes:'9223372036854775800', bytes:7, rawBytes:'7'});
  assert.equal(validateJavaHeapUsed(s).bytes, 7);
  assert.equal(validateJavaHeapUsed(withCounter({rawTotalBeforeBytes:'9223372036854775807', rawTotalAfterBytes:'9223372036854775807', rawFreeBytes:'0', bytes:null, rawBytes:'9223372036854775807', error:'Out of exact numeric range'})).bytes, null);
  for (const change of [{rawBytes:'4097'}, {bytes:4095}, {rawBytes:null}, {bytes:null, error:'failed'}, {error:'failed'}])
    assert.throws(() => validateJavaHeapUsed(withCounter(change)));
});
test('Java heap retains inconsistent or failed inputs without publishing a fabricated value', () => {
  for (const change of [{rawTotalAfterBytes:'12289'}, {rawFreeBytes:'99999'}, {rawTotalBeforeBytes:'-1'},
    {rawFreeBytes:null,rawTotalAfterBytes:null}, {rawTotalBeforeBytes:null,rawFreeBytes:null,rawTotalAfterBytes:null}]) {
    const s = withCounter({...change, bytes:null,rawBytes:null,error:'Unavailable'});
    assert.equal(validateJavaHeapUsed(s).bytes, null); assert.equal(validateMemorySample(s).rssBytes,16384);
    assert.throws(()=>validateJavaHeapUsed(withCounter(change)));
  }
  const s=row(); delete s.javaHeapUsed; assert.throws(()=>validateJavaHeapUsed(s)); assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('Java heap rejects malformed input evidence and wrong units/source/accounting', () => {
  for (const change of [{rawFreeBytes:'08192'}, {rawFreeBytes:8192}, {rawFreeBytes:'-0'}, {rawFreeBytes:undefined},
    {rawTotalBeforeBytes:'9223372036854775808'}, {rawFreeBytes:'-9223372036854775809'},
    {scope:'device'}, {unit:'KiB'}, {accounting:'live_object_bytes'}, {consistency:'atomic'}, {source:'Runtime.maxMemory()'}])
    assert.throws(()=>validateJavaHeapUsed(withCounter(change)));
});
test('Java heap requires Android identity and monotonic interval', () => {
  for(const change of [{platform:'ios'}, {apiLevel:0}, {sequence:0}, {processId:0}, {clockSource:'Date.now'},
    {queryStartedUptimeMs:NaN}, {queryFinishedUptimeMs:999}, {monotonicMs:999}, {osVersion:''}])
    assert.throws(()=>validateJavaHeapUsed({...row(),...change}));
});

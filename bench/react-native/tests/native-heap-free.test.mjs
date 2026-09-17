import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMemorySample, validateNativeHeapFree } from '../src/memory.ts';
const row = (bytes = 4096) => ({
  platform: 'android', osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  sampledAtMs: 1800000000000, clockSource: 'SystemClock.elapsedRealtimeNanos',
  monotonicMs: 1001, queryStartedUptimeMs: 1000, queryFinishedUptimeMs: 1002, readDurationMs: 2,
  source: '/proc/self/smaps_rollup:Rss', rssBytes: 16384, heldBytes: 0,
  nativeHeapFree: { bytes, rawBytes: String(bytes), source: 'Debug.getNativeHeapFreeSize()',
    scope: 'calling_process', unit: 'bytes', accounting: 'native_allocator_free_bytes', error: null },
});
test('native heap free is a gauge independent of RSS and accepts zero, rise and fall', () => {
  for (const n of [0, 1048576, 8192, Number.MAX_SAFE_INTEGER])
    assert.equal(validateNativeHeapFree(row(n)).bytes, n);
  assert.equal(validateNativeHeapFree({...row(), source: '/proc/self/smaps:sum(Rss)'}).bytes, 4096);
});
test('native heap free unavailable preserves other memory and signed raw evidence', () => {
  for (const rawBytes of [null, '-1', '-9223372036854775808', '9007199254740992', '9223372036854775807']) {
    const s = row(); s.nativeHeapFree = {...s.nativeHeapFree, rawBytes, bytes: null, error: 'query/range failure'};
    assert.equal(validateNativeHeapFree(s).bytes, null);
    assert.equal(validateMemorySample(s).rssBytes, 16384);
  }
  const s = row(); delete s.nativeHeapFree;
  assert.throws(() => validateNativeHeapFree(s));
  assert.equal(validateMemorySample(s).rssBytes, 16384);
});
test('native heap free rejects rounding, contradictory errors and corrupt raw values', () => {
  const s = row();
  for (const change of [{bytes: -1}, {bytes: .5}, {bytes: Number.MAX_SAFE_INTEGER + 1},
    {rawBytes: '4097'}, {rawBytes: '04096'}, {rawBytes: '-0'}, {rawBytes: null},
    {rawBytes: '9223372036854775808'}, {rawBytes: '-9223372036854775809'},
    {bytes: null, error: 'failed'}, {error: 'failed'}])
    assert.throws(() => validateNativeHeapFree({...s, nativeHeapFree: {...s.nativeHeapFree, ...change}}));
});
test('native heap free rejects wrong source, scope, units and accounting', () => {
  const s = row();
  for (const change of [{scope: 'device'}, {unit: 'KiB'}, {accounting: 'resident_bytes'}, {source: 'mallinfo().uordblks'}])
    assert.throws(() => validateNativeHeapFree({...s, nativeHeapFree: {...s.nativeHeapFree, ...change}}));
});
test('native heap free verifies Android clock and sample identity', () => {
  for (const change of [{platform: 'ios'}, {apiLevel: 0}, {sequence: 0}, {processId: 0}, {clockSource: 'Date.now'},
    {queryFinishedUptimeMs: 999}, {queryStartedUptimeMs: NaN}, {monotonicMs: 999}, {osVersion: ''}])
    assert.throws(() => validateNativeHeapFree({...row(), ...change}));
});

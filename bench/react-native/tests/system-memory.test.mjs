import assert from 'node:assert/strict';
import test from 'node:test';
import {SystemMemoryTracker, validateSystemMemorySample, validateSystemLowMemory,
  validateSystemLowMemoryThreshold} from '../src/systemMemory.ts';

const sample = (bytes = 1024, extra = {}) => ({availableBytes: bytes, rawAvailableBytes: String(bytes), error: null,
  source: 'ActivityManager.getMemoryInfo().availMem', scope: 'system', platform: 'android',
  osVersion: '16', apiLevel: 36, processId: 123, sequence: 1,
  clockSource: 'SystemClock.elapsedRealtimeNanos', sampledAtMs: 1800000000000,
  queryStartedUptimeMs: 5000, queryFinishedUptimeMs: 5001, ...extra});

test('system availability is a gauge: decreases, zero and resumed fresh reads remain valid', () => {
  const tracker = new SystemMemoryTracker();
  for (const [i, bytes] of [1024, 512, 0, 2048].entries()) {
    assert.equal(tracker.record(sample(bytes, {sequence: i + 1,
      queryStartedUptimeMs: 5000 + 2000 * i, queryFinishedUptimeMs: 5001 + 2000 * i})).availableBytes, bytes);
  }
  assert.throws(() => tracker.record(sample(2048, {sequence: 4})), /out of order/);
  tracker.reset();
  assert.equal(tracker.record(sample(100)).availableBytes, 100);
});

const withLowMemory = (value = false, threshold = 100) => sample(120, {
  lowMemory: {value, source: 'ActivityManager.getMemoryInfo().lowMemory', error: null},
  lowMemoryThreshold: {bytes: threshold, rawBytes: String(threshold),
    source: 'ActivityManager.getMemoryInfo().threshold', error: null},
});

test('preserve OS low-memory transitions independently of availability and the exposed threshold', () => {
  for (const value of [false, true, false]) {
    // AOSP can report lowMemory above the public threshold. Do not reject or recompute it.
    const reading = withLowMemory(value);
    assert.equal(validateSystemLowMemory(reading).value, value);
    assert.equal(validateSystemLowMemoryThreshold(reading).bytes, 100);
    assert.equal(validateSystemMemorySample(reading).availableBytes, 120);
  }
  assert.equal(validateSystemLowMemoryThreshold(withLowMemory(false, 0)).bytes, 0);
});

test('missing and malformed low-memory fields stay unavailable without hiding existing availability', () => {
  for (const value of [0, 1, 'false', undefined, null]) {
    const reading = withLowMemory(value);
    // undefined uses the helper default; set it explicitly for this malformed case.
    reading.lowMemory.value = value;
    assert.throws(() => validateSystemLowMemory(reading));
    assert.equal(validateSystemMemorySample(reading).availableBytes, 120);
    assert.equal(validateSystemLowMemoryThreshold(reading).bytes, 100);
  }
  assert.throws(() => validateSystemLowMemory(sample()));
  assert.throws(() => validateSystemLowMemoryThreshold(sample()));
  const unavailable = withLowMemory();
  unavailable.lowMemory = {...unavailable.lowMemory, value: null, error: 'Read unavailable'};
  assert.equal(validateSystemLowMemory(unavailable).value, null);
  assert.throws(() => validateSystemLowMemory({...unavailable,
    lowMemory: {...unavailable.lowMemory, value: false}}));
  assert.throws(() => validateSystemLowMemory({...withLowMemory(),
    lowMemory: {...withLowMemory().lowMemory, source: 'derived from threshold'}}));
});

test('threshold preserves exact native longs and failures independently of the reported flag', () => {
  for (const raw of ['-1', '-9223372036854775808', '9007199254740992', '9223372036854775807']) {
    const reading = withLowMemory(true);
    reading.lowMemoryThreshold = {...reading.lowMemoryThreshold, bytes: null, rawBytes: raw, error: 'Invalid native threshold'};
    assert.equal(validateSystemLowMemoryThreshold(reading).rawBytes, raw);
    assert.equal(validateSystemLowMemory(reading).value, true);
    assert.throws(() => validateSystemLowMemoryThreshold({...reading,
      lowMemoryThreshold: {...reading.lowMemoryThreshold, error: null}}));
  }
  for (const changes of [{rawBytes: '101'}, {rawBytes: '0100'}, {bytes: 100.5}, {bytes: null},
    {error: 'error with valid value'}, {source: 'app limit'},
    {rawBytes: '9223372036854775808', bytes: null, error: 'Overflow'}]) {
    const reading = withLowMemory(false);
    reading.lowMemoryThreshold = {...reading.lowMemoryThreshold, ...changes};
    assert.throws(() => validateSystemLowMemoryThreshold(reading));
    assert.equal(validateSystemLowMemory(reading).value, false);
  }
});

test('system readings cannot be confused with per-app memory, malformed bytes or missing native data', () => {
  for (const bad of [null, {}, sample(1024, {scope: 'current_app_limit'}),
    sample(1024, {source: 'RSS'}), sample(1024, {platform: 'ios'}),
    sample(1024, {rawAvailableBytes: '1025'}), sample(1024, {rawAvailableBytes: '01024'}),
    sample(1024, {availableBytes: null}), sample(1024, {error: 'Read failed'}),
    sample(1024.5), sample(NaN), sample(1024, {apiLevel: 0}),
    sample(1024, {queryFinishedUptimeMs: 4999}), sample(1024, {sequence: 0}),
    sample(1024, {processId: 0}), sample(1024, {clockSource: 'wall clock'})])
    assert.throws(() => validateSystemMemorySample(bad));
});

test('invalid or imprecise native longs remain explicit and preserve their raw value', () => {
  for (const raw of ['-1', '-9223372036854775808', '9007199254740992', '9223372036854775807']) {
    const reading = sample(null, {rawAvailableBytes: raw, error: 'Native value unavailable'});
    assert.equal(validateSystemMemorySample(reading).rawAvailableBytes, raw);
    assert.throws(() => validateSystemMemorySample({...reading, error: null}));
    assert.throws(() => validateSystemMemorySample({...reading, availableBytes: Number(raw)}));
  }
  assert.equal(validateSystemMemorySample(sample(Number.MAX_SAFE_INTEGER)).availableBytes, Number.MAX_SAFE_INTEGER);
  for (const raw of ['-0', '9223372036854775808', '-9223372036854775809', '0'])
    assert.throws(() => validateSystemMemorySample(sample(null, {rawAvailableBytes: raw, error: 'Invalid'})));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageIoTracker, storageIoSources, validateStorageIoCheck, validProcIo } from '../src/storageIo.ts';
const sample = (platform = 'android', sequence = 1, changes = {}) => ({
  platform, source: storageIoSources[platform], clockSource: 'CLOCK_MONOTONIC', processId: 42, sequence,
  osVersion: 'test', kernelRelease: 'test-kernel', ...(platform === 'android' ? { apiLevel: 36, accountingUnitBytes: 512 } : {}), sampledAtMs: 100000 + sequence * 2000,
  queryStartedUptimeMs: sequence * 2000, queryFinishedUptimeMs: sequence * 2000 + 10,
  counters: {readBytes: 5120, writeBytes: 51200, ...(platform === 'android' ? {readBlocks: 10, writeBlocks: 100} : {})}, ...changes,
});
test('storage rates use actual monotonic intervals and retain raw block counts', () => {
  const tracker = new StorageIoTracker(), first = sample();
  assert.equal(tracker.record(first).window, null);
  const second = sample('android', 2, { sampledAtMs: 1, queryStartedUptimeMs: 7000, queryFinishedUptimeMs: 7010,
    counters: {readBytes: 10240, writeBytes: 56320, readBlocks: 20, writeBlocks: 110} });
  const { window } = tracker.record(second);
  assert.equal(window.elapsedMs, 5000);
  assert.equal(window.perSecond.readBytes, 1024);
  assert.equal(window.perSecond.writeBytes, 1024);
  assert.equal(window.deltas.writeBlocks, 10);
});
test('optional procfs details cannot substitute for or invalidate primary storage counters', () => {
  const row = sample();
  assert.equal(validProcIo(row), null);
  row.procIo = {source: '/proc/self/io', errno: 13, error: 'denied', counters: null};
  assert.equal(validProcIo(row), null);
  assert.equal(new StorageIoTracker().record(row).sample.counters.writeBytes, 51200);
  row.procIo = {source: '/proc/self/io', errno: 0, error: null, counters: {
    readBytes: 10, writeBytes: 20, cancelledWriteBytes: 50, logicalReadBytes: 100, logicalWriteBytes: 200, readCalls: 3, writeCalls: 4,
  }};
  assert.equal(validProcIo(row).cancelledWriteBytes, 50); // Never subtract or clamp.
  row.procIo.counters.readCalls = -1;
  assert.equal(validProcIo(row), null);
});
test('cached reads can have zero storage delta on both platforms', () => {
  for (const platform of ['android', 'ios']) {
    const tracker = new StorageIoTracker();
    tracker.record(sample(platform));
    assert.equal(tracker.record(sample(platform, 2)).window.perSecond.readBytes, 0);
  }
});
test('errors, background resets and new processes require fresh rate baselines', () => {
  const tracker = new StorageIoTracker(); tracker.record(sample());
  assert.throws(() => tracker.record(sample('android', 2, {counters: {...sample().counters, writeBytes: 0, writeBlocks: 0}})), /decreased/);
  assert.equal(tracker.record(sample('android', 3)).window, null);
  tracker.resetWindow(); assert.equal(tracker.record(sample('android', 4)).window, null);
  assert.equal(tracker.record(sample('android', 1, {processId: 99})).window, null);
});
test('reject missing counters, inexact bytes, wrong identity and reordered queries', () => {
  for (const change of [{source: 'other'}, {accountingUnitBytes: 4096}, {kernelRelease: ''}, {counters: {...sample().counters, readBytes: 123}}, {clockSource: 'wall'}, {sequence: 0}, {apiLevel: 0}, {osVersion: ''},
    {queryFinishedUptimeMs: -1}, {counters: {readBytes: 0, writeBytes: 0}},
    {counters: {...sample().counters, readBytes: Number.MAX_SAFE_INTEGER + 1}},
    {counters: {...sample().counters, writeBytes: -1}}]) {
    assert.throws(() => new StorageIoTracker().record(sample('android', 1, change)));
  }
  for (const change of [{sequence: 1}, {queryStartedUptimeMs: 2005}, {queryStartedUptimeMs: 2000, queryFinishedUptimeMs: 2010}]) {
    const tracker = new StorageIoTracker(); tracker.record(sample());
    assert.throws(() => tracker.record(sample('android', 2, change)), /order/);
  }
});
test('file-check windows preserve source, bytes, process and ordering without assuming cold reads', () => {
  const result = {status: 'completed', runSequence: 1, fileBytes: 32 * 1024 * 1024, readPasses: 2,
    cachePolicy: 'buffered_no_eviction', sync: 'fsync', osVersion: 'test', snapshots: [1, 2, 3, 4].map(seq => sample('ios', seq))};
  assert.equal(validateStorageIoCheck(result, 'ios').windows.length, 3);
  for (const change of [{fileBytes: 1}, {readPasses: 1}, {sync: 'none'}, {snapshots: result.snapshots.slice(1)},
    {snapshots: result.snapshots.map((row, i) => i === 2 ? {...row, processId: 99} : row)},
    {snapshots: result.snapshots.map((row, i) => i === 2 ? {...row, sequence: 1} : row)}])
    assert.throws(() => validateStorageIoCheck({...result, ...change}, 'ios'));
});

test('cache-control request acceptance does not manufacture a positive read response', () => {
  for (const platform of ['ios', 'android']) {
    const result = {status: 'completed', runSequence: 1, fileBytes: 32 * 1024 * 1024, readPasses: 2,
      cachePolicy: 'file_cache_control', sync: 'fsync', osVersion: 'test', ...(platform === 'android' ? {apiLevel: 36} : {}),
      cacheControl: {operation: platform === 'ios' ? 'fcntl(F_NOCACHE,1) before write and both reads'
        : 'posix_fadvise(POSIX_FADV_DONTNEED) after fsync, before first read', errno: 0},
      snapshots: [1, 2, 3, 4].map(seq => sample(platform, seq))};
    assert.equal(validateStorageIoCheck(result, platform).windows[1].deltas.readBytes, 0);
    result.cacheControl.errno = 22;
    assert.equal(validateStorageIoCheck(result, platform).result.cacheControl.errno, 22);
    for (const cacheControl of [undefined, {operation: 'global cache flush', errno: 0},
      {...result.cacheControl, errno: -1}, {...result.cacheControl, errno: 0.5}])
      assert.throws(() => validateStorageIoCheck({...result, cacheControl}, platform));
    assert.throws(() => validateStorageIoCheck({...result, cachePolicy: 'buffered_no_eviction'}, platform));
  }
});

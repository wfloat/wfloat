import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCpuHeadroom, cpuHeadroomNote } from '../src/cpuHeadroom.ts';

const sample = {
  source: 'SystemHealthManager.getCpuHeadroom(CpuHeadroomParams)', scope: 'calling_process_default',
  selectedTids: null, availability: 'available', value: 42.5, rawValue: '42.5', reason: null,
  apiLevel: 36, osVersion: '16', pid: 1234, sequence: 1, headroomQueried: true, queryStage: 'headroom',
  sampledAtMs: 10000, queryStartedUptimeMs: 100, queryFinishedUptimeMs: 102, queryDurationMs: 2,
  sensorSampledAtMs: null, minimumPollingIntervalMs: 3000, pollIntervalMs: 3000, nextReadInMs: 2999,
  calculationType: 'average', requestedWindowMs: 2000, supportedWindowMinMs: 1000, supportedWindowMaxMs: 10000,
};

test('CPU headroom accepts genuine zero, float precision and full scale as reported', () => {
  for (const [value, rawValue] of [[0, '0.0'], [100, '100.0'], [50.123451232910156, '50.12345']])
    assert.equal(validateCpuHeadroom({...sample, value, rawValue}).value, value);
  for (const value of [NaN, Infinity, -0.1, 100.1, null])
    assert.throws(() => validateCpuHeadroom({...sample, value}));
});

test('temporary NaN is separate from unsupported and retains a retry interval', () => {
  const temporary = {...sample, availability: 'unavailable', value: null, rawValue: 'NaN', reason: 'temporarily_unavailable'};
  assert.equal(validateCpuHeadroom(temporary).nextReadInMs, 2999);
  assert.match(cpuHeadroomNote(temporary), /Retrying/);
  for (const extra of [{value: 0}, {nextReadInMs: null}, {headroomQueried: false}, {rawValue: null}])
    assert.throws(() => validateCpuHeadroom({...temporary, ...extra}));
});

test('unsupported hardware and older OS preserve missing values and stop polling', () => {
  const unsupported = {...sample, availability: 'unsupported', value: null, rawValue: null,
    reason: 'device_unsupported', headroomQueried: false, queryStage: 'minimum_polling_interval',
    minimumPollingIntervalMs: null, pollIntervalMs: null, nextReadInMs: null,
    calculationType: null, requestedWindowMs: null, supportedWindowMinMs: null, supportedWindowMaxMs: null};
  assert.equal(validateCpuHeadroom(unsupported).value, null);
  assert.match(cpuHeadroomNote(unsupported), /does not support/);
  const old = {...unsupported, apiLevel: 34, reason: 'requires_api_36', queryStage: 'api_level'};
  assert.equal(validateCpuHeadroom(old).availability, 'unsupported');
  assert.match(cpuHeadroomNote(old), /Android 16/);
  assert.throws(() => validateCpuHeadroom({...unsupported, nextReadInMs: 2000}));
});

test('invalid timing, scope or calculation context cannot masquerade as a metric', () => {
  for (const extra of [{pollIntervalMs: 2000}, {nextReadInMs: 3001}, {requestedWindowMs: 999},
      {requestedWindowMs: 10001}, {queryFinishedUptimeMs: 99}, {queryDurationMs: 0},
      {sensorSampledAtMs: 100}, {scope: 'whole_device_utilization'}, {sequence: 0},
      {calculationType: null}, {minimumPollingIntervalMs: null}, {apiLevel: 35}, {rawValue: '5'}])
    assert.throws(() => validateCpuHeadroom({...sample, ...extra}));
});

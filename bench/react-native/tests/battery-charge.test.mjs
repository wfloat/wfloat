import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBatteryCharge, batteryChargeValue, batteryChargeNote} from '../src/batteryCharge.ts';

const sample = (raw = 1234567, extra = {}) => ({
  source: 'BatteryManager.getLongProperty(BATTERY_PROPERTY_CHARGE_COUNTER)', scope: 'battery_remaining_charge',
  platform: 'android', clockSource: 'SystemClock.elapsedRealtimeNanos', environment: 'emulator',
  environmentDetection: 'build_heuristic', collectionMode: 'passive', refreshProbeId: null,
  availability: 'available', reason: null, rawPropertyValue: String(raw), rawMicroampHours: raw, milliampHours: raw / 1000,
  readStartedAtMs: 1000, readCompletedAtMs: 1002, readStartedUptimeMs: 100, readCompletedUptimeMs: 102,
  queryDurationMs: 2, sensorSampledAtMs: null, pid: 123, sequence: 1, apiLevel: 36, osVersion: '16',
  batteryContext: {batteryPresent: true, statusRaw: 2, pluggedRaw: 2, receiptKind: 'sticky_cache',
    receivedAtMs: 900, receivedUptimeMs: 90, sequence: 1}, ...extra,
});

test('charge is a remaining quantity with exact units, including zero; it may rise or fall', () => {
  for (const [raw, text] of [[1234567, '1234.567 mAh'], [1234566, '1234.566 mAh'],
    [1234568, '1234.568 mAh'], [0, '0.000 mAh'], [1, '0.001 mAh'], [2147483647, '2147483.647 mAh']])
    assert.equal(batteryChargeValue(validateBatteryCharge(sample(raw))), text);
  assert.match(batteryChargeNote(sample(0)), /does not establish a physically empty battery/);
  assert.throws(() => validateBatteryCharge(sample(1234567, {milliampHours: 1234567})));
  assert.throws(() => validateBatteryCharge(sample(1234567, {rawPropertyValue: '1234568'})));
});

test('unavailable sentinel, missing service and invalid raw values retain their distinct meanings', () => {
  const sentinel = sample(null, {rawPropertyValue: '-9223372036854775808', availability: 'unavailable',
    reason: 'unsupported_or_error', milliampHours: null});
  assert.equal(batteryChargeValue(validateBatteryCharge(sentinel)), 'Unavailable');
  assert.throws(() => validateBatteryCharge({...sentinel, milliampHours: 0}));
  assert.throws(() => validateBatteryCharge({...sentinel, availability: 'available', reason: null}));
  const missing = sample(null, {rawPropertyValue: null, availability: 'unavailable', reason: 'battery_service_missing', milliampHours: null});
  validateBatteryCharge(missing);
  validateBatteryCharge({...missing, availability: 'error', reason: 'query_failed:SecurityException'});
  for (const raw of [-1, -2147483648, 2147483648]) {
    assert.throws(() => validateBatteryCharge(sample(raw)));
    validateBatteryCharge(sample(raw, {rawMicroampHours: raw > 2147483647 ? null : raw,
      availability: 'error', reason: 'invalid_charge_range', milliampHours: null}));
  }
  assert.throws(() => validateBatteryCharge({...sentinel, rawPropertyValue: '-9223372036854775809'}));
  assert.throws(() => validateBatteryCharge({...missing, reason: 'unsupported_or_error'}));
});

test('charging context remains separate; absent battery suppresses the measurement but retains raw charge', () => {
  const original = sample();
  validateBatteryCharge({...original, batteryContext: null});
  validateBatteryCharge({...original, batteryContext: {...original.batteryContext, batteryPresent: null}});
  const absent = {...original, batteryContext: {...original.batteryContext, batteryPresent: false}};
  assert.throws(() => validateBatteryCharge(absent));
  const row = validateBatteryCharge({...absent, availability: 'unavailable', reason: 'battery_absent', milliampHours: null});
  assert.equal(row.rawMicroampHours, 1234567);
  assert.equal(batteryChargeValue(row), 'Unavailable');
  assert.throws(() => validateBatteryCharge({...original, batteryContext: {...original.batteryContext, receivedUptimeMs: 101}}));
});

test('query timing never claims a sensor timestamp or app-energy scope', () => {
  validateBatteryCharge(sample(1, {readCompletedAtMs: 999})); // Wall-clock adjustments do not change duration.
  validateBatteryCharge(sample(1, {collectionMode: 'refresh_probe', refreshProbeId: 1}));
  for (const changes of [{source: 'BATTERY_PROPERTY_CURRENT_NOW'}, {scope: 'app_energy'},
    {sensorSampledAtMs: 1000}, {queryDurationMs: 3}, {readCompletedUptimeMs: 99},
    {environment: 'physical_guaranteed'}, {rawMicroampHours: 1.5}, {collectionMode: 'refresh_probe', refreshProbeId: null}])
    assert.throws(() => validateBatteryCharge(sample(1, changes)));
});

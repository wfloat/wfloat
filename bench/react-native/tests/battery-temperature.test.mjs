import test from "node:test";
import assert from "node:assert/strict";
import { validateBatteryReport, batteryContext, batteryReceipt } from "../src/batteryTemperature.ts";

const report = { source: "ACTION_BATTERY_CHANGED/EXTRA_TEMPERATURE", availability: "available", reason: null,
  rawTenthsCelsius: 327, celsius: 32.7, batteryPresent: true, statusRaw: 2, pluggedRaw: 1,
  receiptKind: "sticky_cache", receivedAtMs: 1000, receivedUptimeMs: 20, sensorSampledAtMs: null,
  pid: 123, sequence: 1, apiLevel: 34, osVersion: "14" };

test("battery temperatures preserve tenths, zero and negative values", () => {
  for (const raw of [327, 0, -123]) {
    const decoded = validateBatteryReport({ ...report, rawTenthsCelsius: raw, celsius: raw / 10 });
    assert.equal(decoded.celsius, raw / 10);
  }
  for (const celsius of [327, NaN, Infinity, null])
    assert.throws(() => validateBatteryReport({ ...report, celsius }));
});
test("missing data stays unavailable, and absent battery cannot appear valid", () => {
  const missing = validateBatteryReport({ ...report, availability: "unavailable", reason: "temperature_missing", rawTenthsCelsius: null, celsius: null });
  assert.equal(missing.celsius, null);
  assert.throws(() => validateBatteryReport({ ...missing, celsius: 0 }));
  assert.throws(() => validateBatteryReport({ ...report, batteryPresent: false }));
});
test("cache reads retain receipt metadata and never claim a sensor timestamp", () => {
  const first = validateBatteryReport({ ...report });
  const again = validateBatteryReport({ ...report });
  assert.equal(batteryReceipt(first), batteryReceipt(again));
  assert.match(batteryReceipt(first), /Cached OS report received/);
  assert.match(batteryReceipt(first), /Sensor time unavailable/);
  assert.match(batteryReceipt({ ...first, receiptKind: "broadcast" }), /OS update received/);
  assert.throws(() => validateBatteryReport({ ...report, sensorSampledAtMs: 1000 }));
  assert.throws(() => validateBatteryReport({ ...report, receivedUptimeMs: NaN }));
});
test("plugged in and charging are separate context fields", () => {
  assert.equal(batteryContext(report), "Charging · plugged in");
  assert.equal(batteryContext({ ...report, statusRaw: 4 }), "Not charging · plugged in");
  assert.equal(batteryContext({ ...report, statusRaw: 3, pluggedRaw: 0 }), "Discharging · unplugged");
  assert.equal(batteryContext({ ...report, statusRaw: null, pluggedRaw: null }), "Charging state unavailable · power connection unknown");
});

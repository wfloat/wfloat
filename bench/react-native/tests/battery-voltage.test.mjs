import test from "node:test";
import assert from "node:assert/strict";
import { validateBatteryVoltage, batteryVoltageValue, batteryVoltageNote } from "../src/batteryVoltage.ts";
import { batteryReceipt } from "../src/batteryTemperature.ts";

const report = { source: "ACTION_BATTERY_CHANGED/EXTRA_VOLTAGE", availability: "available", reason: null,
  rawMillivolts: 4123, volts: 4.123, batteryPresent: true, statusRaw: 2, pluggedRaw: 2,
  receiptKind: "sticky_cache", receivedAtMs: 1000, receivedUptimeMs: 20, sensorSampledAtMs: null,
  pid: 123, sequence: 1, apiLevel: 34, osVersion: "14" };

test("voltage converts raw mV to V without an extra factor of 1000", () => {
  for (const [raw, expected] of [[1, "0.001 V"], [3999, "3.999 V"], [4123, "4.123 V"], [5000, "5.000 V"]]) {
    const value = validateBatteryVoltage({ ...report, rawMillivolts: raw, volts: raw / 1000 });
    assert.equal(batteryVoltageValue(value), expected);
  }
  assert.throws(() => validateBatteryVoltage({ ...report, volts: 4123 }));
  assert.throws(() => validateBatteryVoltage({ ...report, volts: 0.004123 }));
});
test("zero, missing and absent-battery data cannot masquerade as a usable voltage", () => {
  for (const [raw, reason] of [[0, "zero_voltage"], [null, "voltage_missing"], [4123, "battery_absent"]]) {
    const unavailable = validateBatteryVoltage({ ...report, availability: "unavailable", reason, rawMillivolts: raw, volts: null,
      batteryPresent: reason === "battery_absent" ? false : true });
    assert.equal(batteryVoltageValue(unavailable), "Unavailable");
    assert.throws(() => validateBatteryVoltage({ ...unavailable, volts: 0 }));
  }
  for (const raw of [0, -1, NaN, 0.5])
    assert.throws(() => validateBatteryVoltage({ ...report, rawMillivolts: raw, volts: raw / 1000 }));
  assert.match(batteryVoltageNote({ ...report, reason: "zero_voltage" }), /reports 0 mV/);
});
test("cached voltage keeps receipt identity and does not claim sensor time", () => {
  const first = validateBatteryVoltage({ ...report });
  const next = validateBatteryVoltage({ ...report });
  assert.equal(first.sequence, next.sequence);
  assert.equal(batteryReceipt(first), batteryReceipt(next));
  assert.match(batteryReceipt(first), /Cached OS report received/);
  assert.match(batteryReceipt({ ...first, receiptKind: "broadcast" }), /OS update received/);
  assert.match(batteryReceipt(first), /Sensor time unavailable/);
  assert.throws(() => validateBatteryVoltage({ ...report, sensorSampledAtMs: 1000 }));
  assert.throws(() => validateBatteryVoltage({ ...report, receivedUptimeMs: NaN }));
});

import test from "node:test";
import assert from "node:assert/strict";
import { validateBatteryCurrent, batteryCurrentValue, batteryCurrentNote } from "../src/batteryCurrent.ts";

const sample = {
  source: "BatteryManager.getLongProperty(BATTERY_PROPERTY_CURRENT_NOW)", availability: "available", reason: null,
  rawPropertyValue: "123456", rawMicroamps: 123456, milliamps: 123.456,
  readStartedAtMs: 1000, readCompletedAtMs: 1002, readStartedUptimeMs: 100,
  readCompletedUptimeMs: 102, queryDurationMs: 2, sensorSampledAtMs: null,
  batteryContext: { batteryPresent: true, statusRaw: 2, pluggedRaw: 2,
    receiptKind: "sticky_cache", receivedAtMs: 900, receivedUptimeMs: 0, sequence: 1 },
  pid: 123, sequence: 1, apiLevel: 34, osVersion: "14"
};

test("signed microamps retain direction, zero and resolution when displayed as mA", () => {
  for (const [raw, display, meaning] of [
    [123456, "+123.456 mA", /entering/], [-123456, "-123.456 mA", /leaving/],
    [0, "0.000 mA", /zero/], [1, "+0.001 mA", /entering/], [-1, "-0.001 mA", /leaving/]
  ]) {
    const value = validateBatteryCurrent({ ...sample, rawPropertyValue: String(raw), rawMicroamps: raw, milliamps: raw / 1000 });
    assert.equal(batteryCurrentValue(value), display);
    assert.match(batteryCurrentNote(value), meaning);
  }
  assert.throws(() => validateBatteryCurrent({ ...sample, milliamps: 123456 }));
});
test("unsupported current cannot masquerade as zero or lose its exact sentinel", () => {
  const unavailable = validateBatteryCurrent({ ...sample, availability: "unavailable", reason: "unsupported_or_error",
    rawPropertyValue: "-9223372036854775808", rawMicroamps: null, milliamps: null });
  assert.equal(batteryCurrentValue(unavailable), "Unavailable");
  assert.match(batteryCurrentNote(unavailable), /unsupported or a service error/);
  assert.throws(() => validateBatteryCurrent({ ...unavailable, milliamps: 0 }));
  assert.throws(() => validateBatteryCurrent({ ...unavailable, availability: "available", reason: null }));
  assert.throws(() => validateBatteryCurrent({ ...sample, rawPropertyValue: "-123456" }));
});

test("separate context and API timings do not invent a sensor measurement time", () => {
  assert.equal(validateBatteryCurrent(sample).batteryContext.receivedAtMs, 900);
  assert.equal(validateBatteryCurrent({ ...sample, batteryContext: null }).milliamps, 123.456);
  assert.throws(() => validateBatteryCurrent({ ...sample, sensorSampledAtMs: 1000 }));
  assert.throws(() => validateBatteryCurrent({ ...sample, readCompletedUptimeMs: 99 }));
  assert.throws(() => validateBatteryCurrent({ ...sample, queryDurationMs: 100 }));
  assert.throws(() => validateBatteryCurrent({ ...sample, batteryContext: { ...sample.batteryContext, receivedUptimeMs: 200 } }));
  assert.throws(() => validateBatteryCurrent({ ...sample, batteryContext: { ...sample.batteryContext, batteryPresent: false } }));
  // Wall clocks may adjust; duration and ordering use monotonic time.
  assert.equal(validateBatteryCurrent({ ...sample, readCompletedAtMs: 999 }).queryDurationMs, 2);
});

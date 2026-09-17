import test from "node:test";
import assert from "node:assert/strict";
import { validateHeadroom, headroomNote } from "../src/thermalHeadroom.ts";

const sample = { availability: "available", value: 0.5, rawValue: "0.5", reason: null,
  source: "PowerManager.getThermalHeadroom(0)", forecastSeconds: 0, apiLevel: 34,
  osVersion: "14", pid: 1, sequence: 1, sampledAtMs: 1000, uptimeMs: 100,
  queryDurationMs: 0.2, nextReadInMs: 10000, thermalStatusAtRead: 0 };

test("zero and values above severe remain valid raw readings", () => {
  for (const value of [0, 0.456789, 1, 1.25])
    assert.equal(validateHeadroom({ ...sample, value }).value, value);
});
test("unavailable readings preserve NaN evidence without inventing zero or support diagnosis", () => {
  const missing = validateHeadroom({ ...sample, availability: "unavailable", value: null,
    rawValue: "NaN", reason: "not_reported" });
  assert.equal(missing.value, null);
  assert.equal(missing.rawValue, "NaN");
  assert.match(headroomNote(missing), /unsupported, not ready or rate limited/);
  assert.throws(() => validateHeadroom({ ...missing, value: 0 }));
});
test("invalid values and malformed timing cannot become displayed metrics", () => {
  for (const value of [NaN, Infinity, -1, null])
    assert.throws(() => validateHeadroom({ ...sample, value }));
  for (const key of ["sampledAtMs", "uptimeMs", "queryDurationMs", "nextReadInMs"])
    assert.throws(() => validateHeadroom({ ...sample, [key]: NaN }));
  assert.throws(() => validateHeadroom({ ...sample, nextReadInMs: 10001 }));
  assert.throws(() => validateHeadroom({ ...sample, forecastSeconds: 10 }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { repeatWorkload } from "../src/sustained.ts";

test("Stop during generation lets it finish and starts no further work", async () => {
  let reason = null;
  let calls = 0;
  let finish;
  const completed = [];
  const run = repeatWorkload({
    generate: () => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    onResult: async (result, count) => completed.push([result, count]),
    stopReason: () => reason,
    durationMs: 300000,
    now: () => 0,
  });
  assert.equal(calls, 1);
  reason = "Stopped by you";
  finish("last output");
  assert.deepEqual(await run, { reason, iterations: 1, elapsedMs: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(completed, [["last output", 1]]);
});

test("a generation crossing the deadline completes without another iteration", async () => {
  let now = 0;
  let calls = 0;
  const result = await repeatWorkload({
    generate: async () => {
      calls += 1;
      now += 3000;
    },
    onResult: async () => {},
    stopReason: () => null,
    durationMs: 2000,
    now: () => now,
  });
  assert.equal(calls, 1);
  assert.equal(result.elapsedMs, 3000);
  assert.equal(result.reason, "Five-minute limit reached");
});

test("a thermal stop observed after a result prevents the next generation", async () => {
  let reason = null;
  let calls = 0;
  const result = await repeatWorkload({
    generate: async () => {
      calls += 1;
    },
    onResult: async () => {
      reason = "Thermal state reached LIGHT";
    },
    stopReason: () => reason,
    durationMs: 300000,
    now: () => 0,
  });
  assert.equal(calls, 1);
  assert.equal(result.reason, reason);
});

test("an unavailable thermal reading before start prevents all generation", async () => {
  const result = await repeatWorkload({
    generate: async () => assert.fail("Must not start"),
    onResult: async () => {},
    stopReason: () => "Thermal reading unavailable",
    durationMs: 300000,
    now: () => 0,
  });
  assert.equal(result.iterations, 0);
});

test("generation failures propagate without silently restarting", async () => {
  let calls = 0;
  await assert.rejects(
    repeatWorkload({
      generate: async () => {
        calls += 1;
        throw new Error("Inference failed");
      },
      onResult: async () => assert.fail("No successful result"),
      stopReason: () => null,
      durationMs: 300000,
      now: () => 0,
    }),
    /Inference failed/,
  );
  assert.equal(calls, 1);
});

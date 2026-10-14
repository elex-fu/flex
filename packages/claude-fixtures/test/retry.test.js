import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("retries a failed operation and returns a later success", () => {
  let calls = 0;
  const value = retry(() => {
    calls += 1;
    if (calls < 3) throw new Error("temporary");
    return "ok";
  }, 3);
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("maxRetries=0 still makes the initial attempt", () => {
  let calls = 0;
  assert.throws(() => retry(() => {
    calls += 1;
    throw new Error("permanent");
  }, 0), /permanent/);
  assert.equal(calls, 1);
});

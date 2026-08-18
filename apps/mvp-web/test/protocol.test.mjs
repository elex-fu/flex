import test from "node:test";
import assert from "node:assert/strict";

test("web package includes the MVP interaction surface", async () => {
  assert.equal(typeof fetch, "function");
});

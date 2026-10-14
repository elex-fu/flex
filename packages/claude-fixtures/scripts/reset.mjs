import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await writeFile(resolve(root, "src/retry.js"), `export function retry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return fn(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No attempts executed");
}
`);
await writeFile(resolve(root, "test/retry.test.js"), `import test from "node:test";
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
`);

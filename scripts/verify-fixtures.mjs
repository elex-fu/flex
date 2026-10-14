import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/claude-fixtures");

/** The acceptance fixture must keep exactly its documented boundary failure. */
export async function verifyFixture(root = defaultFixture) {
  const { retry } = await import(pathToFileURL(resolve(root, "src/retry.js")).href + "?verify=" + crypto.randomUUID());
  let attempts = 0;
  assert.equal(retry(() => { if (++attempts < 3) throw new Error("temporary"); return "ok"; }, 3), "ok");
  assert.equal(attempts, 3);
  let boundaryAttempts = 0;
  assert.throws(() => retry(() => { boundaryAttempts++; throw new Error("permanent"); }, 0), {
    message: "No attempts executed",
  });
  assert.equal(boundaryAttempts, 0, "The deliberately broken boundary must not have been repaired");

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This command is an independent test run, including when invoked by tooling tests.
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", resolve(root, "test/retry.test.js")], {
    cwd: root, env, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, "Expected the fixture test command to fail once:\n" + output);
  assert.match(output, /^ok \d+ - retries a failed operation and returns a later success$/m);
  assert.match(output, /^not ok \d+ - maxRetries=0 still makes the initial attempt$/m);
  assert.match(output, /No attempts executed/);
  for (const summary of ["tests 2", "pass 1", "fail 1", "cancelled 0", "skipped 0", "todo 0"]) {
    assert.match(output, new RegExp("^# " + summary + "$", "m"), "Unexpected fixture outcome:\n" + output);
  }
  return { passing: 1, expectedFailures: 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await verifyFixture();
  console.log("Fixture expectations verified: " + outcome.passing + " passing test, " + outcome.expectedFailures + " expected boundary failure.");
}

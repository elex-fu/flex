import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyFixtureWorkspace, ensureFixtureRepository, fixtureSource } from "./provision-fixture-workspace.mjs";
import { copyCleanWorkspace, assertNoBuiltTests } from "./verify-clean.mjs";
import { verifyFixture } from "./verify-fixtures.mjs";
import { verificationEnvironment } from "./verification-env.mjs";

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), "flyx-verification-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("verification explicitly closes all real-provider gates", () => {
  const env = verificationEnvironment({ RUN_REAL_CODEX_SPIKE: "1", RUN_REAL_FUTURE_PROVIDER: "1", OTHER: "kept" });
  assert.equal(env.RUN_REAL_CODEX_SPIKE, "0");
  assert.equal(env.RUN_REAL_CLAUDE_FLOW, "0");
  assert.equal(env.RUN_REAL_FUTURE_PROVIDER, "0");
  assert.equal(env.OTHER, "kept");
});

test("the fixture verifier requires the documented failure and rejects extra failures or a repair", async () => {
  await temporary(async (root) => {
    await cp(fixtureSource, root, { recursive: true, filter: (path) => ![".git", "node_modules"].includes(path.split(/[\\/]/).at(-1)) });
    // Reset only this disposable copy. Product tooling must not require the
    // user's current acceptance fixture to remain broken.
    const reset = spawnSync(process.execPath, [join(root, "scripts/reset.mjs")], { cwd: root });
    assert.equal(reset.status, 0);
    assert.deepEqual(await verifyFixture(root), { passing: 1, expectedFailures: 1 });
    const baseline = await readFile(join(root, "src/retry.js"), "utf8");
    await writeFile(join(root, "test/retry.test.js"), 'import test from "node:test"; test("unrelated failure", () => { throw new Error("oops"); });\n');
    await assert.rejects(verifyFixture(root));
    const repaired = baseline.replace("attempt < maxRetries", "attempt <= maxRetries");
    await writeFile(join(root, "src/retry.js"), repaired);
    await assert.rejects(verifyFixture(root));
  });
});

test("fixture provisioning creates its own Git root and preserves existing content and history", async () => {
  await temporary(async (root) => {
    const destination = join(root, "fixture");
    await copyFixtureWorkspace(destination);
    const before = spawnSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(before.status, 0);
    const top = spawnSync("git", ["-C", destination, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    assert.equal(top.stdout.trim(), await realpath(destination));
    await writeFile(join(destination, "untracked.txt"), "keep me\n");
    await ensureFixtureRepository(destination);
    const after = spawnSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(after.stdout, before.stdout);
    assert.equal(await readFile(join(destination, "untracked.txt"), "utf8"), "keep me\n");
    await assert.rejects(copyFixtureWorkspace(destination), /already exists/);
  });
});

test("clean verification copies sources without touching existing build output", async () => {
  await temporary(async (root) => {
    const source = join(root, "source");
    const copy = join(root, "copy");
    await mkdir(join(source, "packages/example/dist"), { recursive: true });
    await mkdir(join(source, "packages/example/src"), { recursive: true });
    await writeFile(join(source, "packages/example/dist/stale.test.js"), "preserved");
    await writeFile(join(source, "packages/example/src/index.ts"), "export {};\n");
    await copyCleanWorkspace(source, copy);
    assert.equal(await readFile(join(source, "packages/example/dist/stale.test.js"), "utf8"), "preserved");
    await assert.rejects(stat(join(copy, "packages/example/dist")), { code: "ENOENT" });
    assert.equal(await readFile(join(copy, "packages/example/src/index.ts"), "utf8"), "export {};\n");
    await assert.rejects(copyCleanWorkspace(source, join(source, "nested-copy")), /outside/);
    await mkdir(join(copy, "apps"));
    await mkdir(join(copy, "packages/example/dist"));
    await writeFile(join(copy, "packages/example/dist/index.js"), "export {};\n");
    await assertNoBuiltTests(copy);
    await writeFile(join(copy, "packages/example/dist/stale.test.js"), "unexpected");
    await assert.rejects(assertNoBuiltTests(copy), /emitted a test/);
  });
});

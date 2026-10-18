import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROLLED_RESTORE_HELPER } from "../checkpoint/controlled-restore-helper.js";
import {
  createFixtureManagedGitRunner, fixtureLaunchContext, fixtureTreeStopBackend,
  memoryProcessJournal, trustedFixtureGit,
} from "../test-support/managed-git-fixtures.js";
import { ManagedGitRunner, type ManagedGitStopBackend } from "./managed-git-runner.js";
import { processIdentityDigest, type ManagedProcessRecord } from "./managed-process-registry.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flyx-managed-git-")));
  roots.push(root);
  await run(trustedFixtureGit(), ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  return root;
}
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("CONDITION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function latest(journal: { records: ManagedProcessRecord[] }): ManagedProcessRecord { return journal.records.at(-1)!; }

describe("managed Git and helper runner", { timeout: 30_000 }, () => {
  it("runs an allowlisted read through the fixed policy and succeeds only with a verified tree stop", async () => {
    const root = await repository();
    const journal = memoryProcessJournal();
    const runner = createFixtureManagedGitRunner({ journal });
    const request = Object.freeze({
      purpose: "checkpoint_read" as const, args: Object.freeze(["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"]),
      cwd: root, maxOutputBytes: 64 * 1024, timeoutMs: 5_000,
    });
    const result = await runner.run(request);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({ purpose: "checkpoint_read", policyId: "managed-git/checkpoint-read/v1", exitCode: 0, state: "stopped", stopped: true });
    expect(result.stopProof).toMatchObject({ kind: "verified-tree-stop", contractId: "fixture-verified-tree-stop/v1" });
    expect(Buffer.from(result.stdout).toString("utf8").trim()).toBe(root);
    const record = journal.records.find((item) => item.id === result.processId)!;
    expect(record).toMatchObject({ state: "stopped", pid: expect.any(Number) });
    expect(result.stopProof.identityDigest).toBe(processIdentityDigest(record.processIdentity!));
    expect(record.boundaryEvidence).toMatchObject({ launchDigest: result.launchDigest, proof: { purpose: "checkpoint_read", policyId: "managed-git/checkpoint-read/v1" } });
    // The launch digest is fixed before dispatch: an identical request repeats it, a different binding does not.
    const again = await runner.run(request);
    expect(again.launchDigest).toBe(result.launchDigest);
    const identified = await runner.run({ ...request, operationId: "operation-1" });
    expect(identified.launchDigest).not.toBe(result.launchDigest);
    expect((await runner.closeAndWait(1_000))).toMatchObject({ closed: true, producerStopped: true, clean: true });
    runner.sealJournal();
  });

  it("rejects bounded-output overflow and a blocked stdin as typed stopped failures", async () => {
    const root = await repository();
    const runner = createFixtureManagedGitRunner();
    for (let index = 0; index < 64; index += 1) await writeFile(join(root, `untracked-${index}.txt`), "x");
    await expect(runner.run({ purpose: "checkpoint_read", args: ["ls-files", "-z", "--others"], cwd: root, maxOutputBytes: 128, timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: "MANAGED_GIT_OUTPUT_BUDGET_EXCEEDED", state: "stopped" });
    // No input means the runner keeps stdin open, so `hash-object --stdin` blocks until the timeout stops the tree.
    await expect(runner.run({ purpose: "checkpoint_read", args: ["hash-object", "--stdin"], cwd: root, maxOutputBytes: 1024, timeoutMs: 400 }))
      .rejects.toMatchObject({ code: "MANAGED_GIT_TIMEOUT", state: "stopped" });
    await runner.closeAndWait(1_000);
    runner.sealJournal();
  });

  it("keeps a durable unknown process and throws when the stop backend cannot prove the descendant tree", async () => {
    const root = await repository();
    const journal = memoryProcessJournal();
    const unproven: ManagedGitStopBackend = { kind: "fixture", contractId: "expected-contract", verifiedDescendantStop: true, verify: () => undefined };
    const mismatched: ManagedGitStopBackend = {
      kind: "fixture", contractId: "expected-contract", verifiedDescendantStop: true,
      verify: (record) => record.processIdentity === undefined ? undefined : {
        kind: "verified-tree-stop", sourceId: `mismatched:${record.id}`, identityDigest: processIdentityDigest(record.processIdentity), contractId: "another-contract",
      },
    };
    for (const backend of [unproven, mismatched]) {
      const refused = new ManagedGitRunner({
        journal, context: () => fixtureLaunchContext(), stopBackend: backend, allowFixtureStopBackend: true,
        roots: () => [], privateRoots: [], gitExecutable: trustedFixtureGit(),
      });
      await expect(refused.run({ purpose: "checkpoint_read", args: ["rev-parse", "--show-toplevel"], cwd: root, maxOutputBytes: 64 * 1024, timeoutMs: 5_000 }))
        .rejects.toMatchObject({ code: "MANAGED_GIT_TREE_STOP_UNPROVEN", state: "unknown" });
      const record = latest(journal);
      expect(record.state).toBe("unknown");
      expect(record.stopProof).toBeUndefined();
      await refused.closeAndWait(1_000);
      refused.sealJournal();
    }
  });

  it("refuses every unproven, fixture-only or platform-less stop contract before any process exists", () => {
    const base = { journal: memoryProcessJournal(), context: () => fixtureLaunchContext(), roots: () => [], privateRoots: [], gitExecutable: trustedFixtureGit() };
    const refusal = (build: () => unknown): unknown => { try { build(); } catch (error) { return error; } return undefined; };
    expect(refusal(() => new ManagedGitRunner({ ...base, stopBackend: undefined as never }))).toMatchObject({ code: "MANAGED_GIT_STOP_BACKEND_REQUIRED", state: "not_spawned" });
    expect(refusal(() => new ManagedGitRunner({ ...base, stopBackend: { kind: "fixture", contractId: "contract", verifiedDescendantStop: false as never, verify: () => undefined } })))
      .toMatchObject({ code: "MANAGED_GIT_STOP_BACKEND_UNVERIFIED", state: "not_spawned" });
    expect(refusal(() => new ManagedGitRunner({ ...base, stopBackend: fixtureTreeStopBackend() }))).toMatchObject({ code: "MANAGED_GIT_FIXTURE_BACKEND_FORBIDDEN" });
    if (process.platform !== "linux") {
      expect(refusal(() => new ManagedGitRunner({ ...base, stopBackend: { kind: "supervisor", contractId: "c0-supervisor", verifiedDescendantStop: true, verify: () => undefined } })))
        .toMatchObject({ code: "MANAGED_GIT_SUPERVISOR_UNAVAILABLE", state: "not_spawned" });
    }
    expect(refusal(() => createFixtureManagedGitRunner({ gitExecutable: process.execPath }))).toMatchObject({ code: "MANAGED_GIT_EXECUTABLE_UNTRUSTED" });
    expect(refusal(() => new ManagedGitRunner({ ...base, gitExecutable: "/not/absolute", stopBackend: fixtureTreeStopBackend(), allowFixtureStopBackend: true })))
      .toMatchObject({ code: "MANAGED_GIT_EXECUTABLE_UNTRUSTED" });
  });

  it("stops the active producer before draining on close and refuses every later run", async () => {
    const root = await repository();
    const journal = memoryProcessJournal();
    const runner = createFixtureManagedGitRunner({ journal });
    const pending = runner.run({ purpose: "checkpoint_read", args: ["hash-object", "--stdin"], cwd: root, maxOutputBytes: 1024, timeoutMs: 30_000 });
    await waitFor(() => journal.records.some((record) => record.state === "running"));
    const report = await runner.closeAndWait(2_000);
    expect(report).toMatchObject({ closed: true, producerStopped: true });
    // The run settles only from the stop path; a successful close never leaves it pending.
    const settled = await pending;
    expect(settled).toMatchObject({ state: "stopped", stopped: true });
    expect(Number.isInteger(settled.exitCode)).toBe(true);
    expect(latest(journal)).toMatchObject({ state: "stopped", stopProof: expect.objectContaining({ kind: "verified-tree-stop" }) });
    await expect(runner.run({ purpose: "checkpoint_read", args: ["rev-parse", "--show-toplevel"], cwd: root, maxOutputBytes: 1024, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "MANAGED_GIT_CLOSED", state: "not_spawned" });
    runner.sealJournal();
  });

  it("commits the helper launch boundary before the caller writes any mutation input", async () => {
    const root = await repository();
    const journal = memoryProcessJournal();
    const runner = createFixtureManagedGitRunner({ journal });
    const launcher = runner.helperLauncher();
    await expect(launcher({ command: "/usr/bin/true", args: ["-I", "-c", CONTROLLED_RESTORE_HELPER], env: {}, purpose: "read" })).rejects.toMatchObject({ code: "MANAGED_GIT_INPUT_INVALID" });
    const child = await launcher({ command: "/usr/bin/python3", args: ["-I", "-c", CONTROLLED_RESTORE_HELPER], env: {}, purpose: "mutate", operationId: "operation-helper", stepId: "step-1", workspace: root });
    const record = latest(journal);
    expect(record).toMatchObject({ state: "running", pid: expect.any(Number) });
    expect(record.boundaryEvidence).toMatchObject({ proof: { purpose: "restore_helper", policyId: "managed-git/restore-helper/v1", operationId: "operation-helper", stepId: "step-1" } });
    expect(record.boundaryEvidence!.launchDigest).toMatch(/^[a-f0-9]{64}$/);
    const output = await new Promise<string>((resolve, reject) => {
      let bytes = ""; child.stdout?.on("data", (data: Buffer) => { bytes += data.toString("utf8"); });
      child.once("error", reject);
      void child.exited.then(async (exit) => {
        const stream = child.stdout;
        if (stream && !stream.readableEnded && !stream.destroyed) await new Promise<void>((done) => { stream.once("end", () => done()); stream.once("close", () => done()); });
        if (exit.code === 0) resolve(bytes); else reject(new Error(`helper exit ${exit.code}`));
      });
      child.stdin?.end(JSON.stringify({ op: "probe" }));
    });
    expect(JSON.parse(output)).toEqual({ ok: true, result: { supported: true } });
    await runner.closeAndWait(2_000);
    expect(journal.records.find((item) => item.id === record.id)).toMatchObject({ state: "stopped", stopProof: expect.objectContaining({ kind: "verified-tree-stop" }) });
    runner.sealJournal();
    await expect(runner.helperLauncher()({ command: "/usr/bin/python3", args: ["-I", "-c", CONTROLLED_RESTORE_HELPER], env: {}, purpose: "read" })).rejects.toMatchObject({ code: "MANAGED_GIT_CLOSED" });
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExclusiveFileLock, HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { RepositoryMetadataLocks } from "./repository-metadata-lock.js";
import { WorkspaceLease } from "./workspace-lease.js";
import { HostExecutionPermits } from "./host-execution-permits.js";
import { SystemProcessInspector, type ProcessInspector } from "../lifecycle/process-inspector.js";

const roots: string[] = [], owners: HostOwnerHandle[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) owner.release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() }; }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flyx-repository-lock-"))); roots.push(root);
  const common = join(root, "common"), other = join(root, "other"), checkout = join(root, "checkout");
  for (const path of [common, other, checkout]) mkdirSync(path);
  const alias = join(root, "alias"); symlinkSync(common, alias);
  const owner = (name: string) => { const value = HostOwnerLock.acquire({ databasePath: join(root, name, "state.sqlite"), identityDirectory: join(root, name, "identity"), coordinationDirectory: join(root, "coordination") }); owners.push(value); return value; };
  const first = owner("first"), second = owner("second");
  let stopped = true;
  const locks = (host = first) => new RepositoryMetadataLocks({ owner: host, commonDirectory: async (path) => path, producerStopped: async () => stopped });
  return { root, common, other, checkout, alias, first, second, locks, stopKnown: (value: boolean) => { stopped = value; } };
}
describe("short common-directory Git metadata locks", () => {
  it("excludes another Host through canonical aliases and releases after verified helpers stop", async () => {
    const f = fixture(), first = f.locks(), second = f.locks(f.second), held = gate(), entered = gate();
    const run = first.run(f.common, "first", async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    let invoked = false;
    await expect(second.run(f.alias, "second", async () => { invoked = true; })).rejects.toThrow("Another Host");
    expect(invoked).toBe(false);
    held.resolve(); await run;
    await second.run(f.alias, "after-stop", async () => { invoked = true; }); expect(invoked).toBe(true);
  });
  it("retains unknown metadata producers and only releases with operation-bound recovery evidence", async () => {
    const f = fixture(), locks = f.locks(); f.stopKnown(false);
    await expect(locks.run(f.common, "unknown", async () => undefined)).rejects.toThrow("REPOSITORY_PRODUCER_UNKNOWN");
    expect(locks.retainedCount).toBe(1);
    f.stopKnown(true);
    await expect(f.locks(f.second).run(f.common, "blocked", async () => undefined)).rejects.toThrow("Another Host");
    const proof = { ownerId: f.first.ownerId, ownerGeneration: f.first.generation, evidenceId: "verified", turnId: "unknown", attemptId: "attempt", resourceKeys: [`repository:${f.common}`] };
    expect(() => locks.releaseAfterRecovery("different", { proof, verifyProof: () => true })).toThrow("EVIDENCE_INVALID");
    expect(() => locks.releaseAfterRecovery("unknown", { proof, verifyProof: () => false })).toThrow("did not prove");
    locks.releaseAfterRecovery("unknown", { proof, verifyProof: () => true });
    await f.locks(f.second).run(f.common, "after-recovery", async () => undefined);
  });
  it("takes multiple metadata keys in sorted order after checkout and refuses lock inversion", async () => {
    const f = fixture(), locks = f.locks(), lease = WorkspaceLease.acquire({ workspace: f.checkout, owner: f.first });
    const acquire = vi.spyOn(ExclusiveFileLock, "acquire");
    await locks.run([f.other, f.common, f.alias], "ordered", async () => {
      expect(() => WorkspaceLease.acquire({ workspace: f.checkout, owner: f.second })).toThrow("WORKSPACE_LOCK_ORDER_INVALID");
      await expect(new HostExecutionPermits().acquire("inverted")).rejects.toThrow("HOST_EXECUTION_PERMIT_LOCK_ORDER_INVALID");
      await expect(locks.run(f.common, "nested", async () => undefined)).rejects.toThrow("REPOSITORY_LOCK_NESTING_INVALID");
    });
    expect(acquire.mock.calls.map(([options]) => options.resourceKey)).toEqual([`repository:${f.common}`, `repository:${f.other}`].sort());
    lease.release();
  });
  it("validates every retained resource before clearing any recovery gate", async () => {
    const f = fixture(), locks = f.locks(); f.stopKnown(false);
    await expect(locks.run([f.common, f.other], "unknown-two", async () => undefined)).rejects.toThrow("PRODUCER_UNKNOWN");
    const proof = { ownerId: f.first.ownerId, ownerGeneration: f.first.generation, evidenceId: "verified-two", turnId: "unknown-two", attemptId: "attempt", resourceKeys: [`repository:${f.common}`, `repository:${f.other}`] };
    expect(() => locks.releaseAfterRecovery("unknown-two", { proof, verifyProof: (_proof, context) => context.resourceKey !== `repository:${f.other}` })).toThrow("did not prove");
    expect(locks.retainedCount).toBe(2); f.stopKnown(true);
    for (const path of [f.common, f.other]) await expect(f.locks(f.second).run(path, "still-blocked", async () => undefined)).rejects.toThrow("Another Host");
    locks.releaseAfterRecovery("unknown-two", { proof, verifyProof: () => true }); expect(locks.retainedCount).toBe(0);
  });
  it("fences queued actions during close without releasing or cancelling the running lock", async () => {
    const f = fixture(), locks = f.locks(), held = gate(), entered = gate();
    const first = locks.run(f.common, "running", async () => { entered.resolve(); await held.promise; }); await entered.promise;
    let invoked = false;
    const waiting = locks.run(f.common, "waiting", async () => { invoked = true; });
    const rejected = expect(waiting).rejects.toThrow("SEALED"); locks.seal(); held.resolve();
    await first; await rejected; expect(invoked).toBe(false);
    await f.locks(f.second).run(f.common, "other-host", async () => undefined);
  });
  it("does not query Git after seal and lets independent common directories run concurrently", async () => {
    const f = fixture(), query = vi.fn(async (path: string) => path);
    const locks = new RepositoryMetadataLocks({ owner: f.first, commonDirectory: query, producerStopped: async () => true });
    const held = gate(), entered = gate();
    const running = locks.run(f.common, "one", async () => { entered.resolve(); await held.promise; }); await entered.promise;
    let independent = false;
    await locks.run(f.other, "two", async () => { independent = true; }); expect(independent).toBe(true);
    locks.seal(); const before = query.mock.calls.length;
    await expect(locks.run(f.other, "closed", async () => undefined)).rejects.toThrow("SEALED");
    expect(query.mock.calls).toHaveLength(before); held.resolve(); await running;
  });
  it("holds original cross-restart identities and purposes until every resource and committed CAS pass (deterministic inspector)", async () => {
    const f = fixture(), original = f.locks(); f.stopKnown(false);
    await expect(original.run([f.common, f.other], "capture-original", async () => undefined)).rejects.toThrow("PRODUCER_UNKNOWN");
    f.stopKnown(true); const restarted = f.locks(f.second);
    let processState: "alive" | "unknown" | "exited" = "unknown", failSecond = false, revision = 3;
    const inspect = vi.fn(() => ({ state: processState, reason: "deterministic-fixture" }));
    const inspector: ProcessInspector = { currentIdentity: () => new SystemProcessInspector().currentIdentity(), inspect };
    const commitAuthorization = vi.fn(() => { if (revision !== 3) throw new Error("VERSION_CONFLICT"); revision++; });
    const authorize = (ownership: { ownerId: string; ownerGeneration: number; resourceKey: string; purpose: string }) => {
      expect(ownership.purpose).toBe("repository:capture-original"); expect(ownership.ownerId).toBe(f.first.ownerId);
      return {
      proof: { ownerId: ownership.ownerId, ownerGeneration: ownership.ownerGeneration, evidenceId: "committed-resume-gate", turnId: "capture-original", attemptId: "original-attempt", resourceKeys: [ownership.resourceKey] },
      verifyProof: (_proof: unknown, context: { resourceKey: string; purpose: string }) => context.purpose === "repository:capture-original" && (!failSecond || context.resourceKey !== `repository:${f.other}`),
      };
    };
    const recover = () => restarted.recoverRetained({ commonDirectories: [f.other, f.common], inspector, authorize, commitAuthorization });
    expect(() => recover()).toThrow("cannot be proven exited"); processState = "alive";
    expect(() => recover()).toThrow("cannot be proven exited"); expect(commitAuthorization).not.toHaveBeenCalled();
    processState = "exited"; failSecond = true;
    expect(() => recover()).toThrow("did not prove"); expect(commitAuthorization).not.toHaveBeenCalled();
    for (const path of [f.common, f.other]) await expect(f.locks(f.second).run(path, "blocked", async () => undefined)).rejects.toThrow("Another Host");
    failSecond = false; revision = 4; expect(() => recover()).toThrow("VERSION_CONFLICT");
    revision = 3; expect(recover()).toBe(2);
    expect(inspect.mock.calls.length).toBeGreaterThan(0);
    await restarted.run([f.common, f.other], "successor", async () => undefined);
  });
});

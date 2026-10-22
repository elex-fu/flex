import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator } from "./orchestrator.js";
import { temporaryRepository, removeFixture } from "../checkpoint/test-support.js";
import { rawGitServiceRunner } from "../test-support/managed-git-fixtures.js";
import type { ProviderAdapter, ProviderOutcome } from "../provider/types.js";

const open: Array<{ host: SessionOrchestrator; root: string }> = [];
afterEach(async () => { for (const f of open.splice(0)) { await f.host.closeAndWait().catch(() => {}); await removeFixture(f.root); } });
async function fixture() {
  const root = await temporaryRepository(); let helpersStopped = true;
  const begin = vi.fn();
  const outcome: ProviderOutcome = { status: "completed", providerSessionId: "native", evidence: { kind: "native-terminal", sourceId: "fixture-native-result" } };
  const adapter: ProviderAdapter = { provider: "claude", workspace: root,
    status: async () => { throw new Error("No Provider status query"); }, preflight: async () => { throw new Error("No Provider launch"); },
    runTurn: async () => outcome, beginTurn: () => { begin(); return { outcome: Promise.resolve(outcome) }; },
    interrupt: async () => "accepted", respondApproval: () => true };
  const host = new SessionOrchestrator({ workspace: root, adapter, gitRunner: rawGitServiceRunner(),
    canReleaseWorkspace: () => true, canReleaseAdditionalProducers: () => helpersStopped });
  for (const id of ["actor", "other"]) host.store.createDevice({ id, hostId: "test-host", platform: "test", credentialKind: "browser-session",
    credentialRevision: 0, scopes: ["session:read", "session:write"], createdAt: new Date().toISOString() });
  open.push({ host, root });
  return { host, begin, setHelpersStopped: (value: boolean) => { helpersStopped = value; } };
}

describe("idle checkpoint checkout reservations", { timeout: 30_000 }, () => {
  it("holds the same actual lease across preview and revert without launching Native", async () => {
    const f = await fixture(); const revision = f.host.store.getSession(f.host.sessionId)!.revision;
    const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview", expectedSessionRevision: revision });
    expect(f.host.workspaceLease).toBe(lease); lease.assertActive();
    expect(await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "revert", previousLease: { leaseId: lease.operationId, generation: f.host.owner.generation } })).toBe(lease);
    await expect(f.host.ensureCheckpointLease({ actorId: "other", purpose: "preview" })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(f.begin).not.toHaveBeenCalled(); expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(true);
  });
  it("invalidates an idle preview for a new task and rejects its old lease", async () => {
    const f = await fixture(); const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    await f.host.startTurn("actor", "new-task", "run");
    await f.host.worker.drainDispatch(); await f.host.worker.drainOperations();
    expect(f.begin).toHaveBeenCalledOnce();
    await expect(f.host.ensureCheckpointLease({ actorId: "actor", purpose: "revert", previousLease: { leaseId: lease.operationId, generation: f.host.owner.generation } })).rejects.toMatchObject({ code: "REVERT_WORKSPACE_LEASE_REQUIRED" });
  });
  it("retains ownership when a preview helper stop is unknown", async () => {
    const f = await fixture(); const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    f.setHelpersStopped(false); expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(false);
    await expect(f.host.startTurn("actor", "blocked-new-task", "run")).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(f.host.workspaceLease).toBe(lease); expect(f.begin).not.toHaveBeenCalled();
    f.setHelpersStopped(true); expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(true);
  });
  it("rechecks actor revocation when reusing the reservation", async () => {
    const f = await fixture(); const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    f.host.store.db.prepare("UPDATE devices SET revoked_at=? WHERE id='actor'").run(new Date().toISOString());
    await expect(f.host.ensureCheckpointLease({ actorId: "actor", purpose: "revert" })).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    expect(f.host.releaseCheckpointLease(lease.operationId)).toBe(true);
  });
  it("expires a stopped unused preview and fences its timer before Store close", async () => {
    const f = await fixture(); const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    f.host.bindCheckpointPreviewExpiry(lease.operationId, new Date(Date.now() + 30).toISOString());
    await vi.waitFor(() => expect(f.host.workspaceLease).toBeUndefined());
    await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    expect(await f.host.closeAndWait()).toMatchObject({ clean: true, producerStopped: true });
    expect(f.host.store.db.open).toBe(false);
  });
  it("serializes racing preview actors without taking two checkout leases", async () => {
    const f = await fixture(); const results = await Promise.allSettled([
      f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" }),
      f.host.ensureCheckpointLease({ actorId: "other", purpose: "preview" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.host.releaseCheckpointLease(f.host.workspaceLease!.operationId)).toBe(true);
  });
  it("does not poison ownership when a new task races an unfinished preview", async () => {
    const f = await fixture(); const lease = await f.host.ensureCheckpointLease({ actorId: "actor", purpose: "preview" });
    f.host.beginCheckpointPreview(lease.operationId, "actor");
    expect(() => f.host.cancelCheckpointPreviewForNewTask()).toThrow("Preview helpers");
    expect(f.host.finishCheckpointPreview(lease.operationId, "other")).toBe(false);
    expect(f.host.finishCheckpointPreview(lease.operationId, "actor")).toBe(true);
    expect(() => f.host.cancelCheckpointPreviewForNewTask()).not.toThrow();
    expect(f.host.workspaceLease).toBeUndefined();
  });
});

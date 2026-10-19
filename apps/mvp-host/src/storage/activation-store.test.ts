import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_V10_SCHEMA } from "../test-support/frozen-v10-schema.js";
import {
  ACTIVATION_FIXTURE_ACTOR, ACTIVATION_FIXTURE_NOW, captureError, createActivationFixture, disposeActivationFixtures,
} from "../test-support/activation-fixture.js";
import { parseActivationPayload } from "../lifecycle/host-activation-load.js";
import { SqliteStore } from "./db.js";
import {
  activationConsumeRequestHash, activationRequestHash, createActivationOperationStore, newActivationOperationId,
} from "./activation-store.js";

const processes = vi.hoisted(() => ({
  execFile: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execFileSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  spawn: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
}));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), ...processes }));

beforeEach(() => { for (const process of Object.values(processes)) process.mockClear(); });
afterEach(() => { disposeActivationFixtures(); });
function noProcesses() { for (const process of Object.values(processes)) expect(process).not.toHaveBeenCalled(); }

describe("activation operation store", () => {
  it("stays unavailable and unwritable on a pre-011 Store", () => {
    const store = new SqliteStore(":memory:", { mode: "test-fixture", fixtureSchema: FROZEN_V10_SCHEMA });
    try {
      const operations = createActivationOperationStore({ db: store.db, workspace: () => undefined, provider: () => undefined }, { guard: () => {} });
      expect(operations.available).toBe(false);
      const ownerContext = { ownerId: "owner", ownerGeneration: 1, resourceKeys: [] };
      expect(captureError(() => operations.begin({
        id: newActivationOperationId(), actorId: "actor", commandId: "command", kind: "activation", requestHash: "hash",
        ownerContext, resourceBinding: { workspaceId: "workspace", providerInstanceId: "provider" },
      }))).toMatchObject({ code: "ACTIVATION_SCHEMA_UNAVAILABLE" });
      expect(captureError(() => operations.withdrawReadiness("workspace", "workspace", { at: ACTIVATION_FIXTURE_NOW, reasonCodes: [] })))
        .toMatchObject({ code: "ACTIVATION_SCHEMA_UNAVAILABLE" });
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='host_execution_operations'").get()).toEqual({ n: 0 });
    } finally { store.close(); }
  });

  it("requires a writer owner guard and stable request hashes", () => {
    const f = createActivationFixture();
    expect(captureError(() => createActivationOperationStore({ db: f.store.db, workspace: () => undefined, provider: () => undefined }, {} as never)))
      .toMatchObject({ code: "ACTIVATION_OWNER_INVALID" });
    expect(newActivationOperationId()).toMatch(/^[a-f0-9-]{36}$/);
    const request = { kind: "activation" as const, workspaceId: "workspace", providerInstanceId: "provider", requestFormatVersion: 1 };
    expect(activationRequestHash(request)).toMatch(/^[a-f0-9]{64}$/);
    expect(activationRequestHash(request)).toBe(activationRequestHash({ ...request }));
    expect(activationRequestHash({ ...request, workspaceId: "other" })).not.toBe(activationRequestHash(request));
    expect(activationConsumeRequestHash("evidence")).toMatch(/^[a-f0-9]{64}$/);
    expect(activationConsumeRequestHash("evidence")).not.toBe(activationConsumeRequestHash("other-evidence"));
    noProcesses();
  }, 20000);

  it("makes acceptance retry-safe and rejects command-ID reuse for another request", () => {
    const f = createActivationFixture();
    const ownerContext = { ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, resourceKeys: [...f.owner.resourceKeys] };
    const resourceBinding = { workspaceId: "workspace", providerInstanceId: "provider" };
    const requestHash = activationRequestHash({ kind: "activation", workspaceId: "workspace", providerInstanceId: "provider", requestFormatVersion: 1 });
    const begin = () => f.operations.begin({ id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-command", kind: "activation", requestHash, ownerContext, resourceBinding });
    const first = begin();
    expect(first.state).toBe("accepted");
    expect(begin().id).toBe(first.id);
    expect(f.operations.operationForCommand(ACTIVATION_FIXTURE_ACTOR, "store-command")?.id).toBe(first.id);
    expect(captureError(() => f.operations.begin({ id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-command", kind: "activation", requestHash: "different", ownerContext, resourceBinding })))
      .toMatchObject({ code: "ACTIVATION_EVIDENCE_INVALID" });
    expect(captureError(() => f.operations.begin({ id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-command", kind: "activation", requestHash, ownerContext, resourceBinding: { workspaceId: "workspace", providerInstanceId: "other" } })))
      .toMatchObject({ code: "ACTIVATION_EVIDENCE_INVALID" });
    expect(captureError(() => f.operations.begin({ id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-other", kind: "other" as never, requestHash, ownerContext, resourceBinding })))
      .toMatchObject({ code: "ACTIVATION_EVIDENCE_INVALID" });
    noProcesses();
  }, 20000);

  it("CASes resource revisions, persists a rejected receipt and resumes a completed one", async () => {
    const f = createActivationFixture();
    f.writePassedEvidence();
    const service = f.service();
    const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "store-verify" });
    expect(f.operations.recordDigests("workspace", "workspace")).toEqual({ readinessRevision: 0 });
    expect(f.operations.referencedOperation("workspace", "workspace")).toBeUndefined();
    expect(f.operations.isReadinessReachable("workspace", "workspace")).toBe(false);
    expect(f.operations.recordDigests("provider", "provider")).toEqual({ readinessRevision: 0 });
    expect(f.operations.resourceTargets()).toEqual([
      { kind: "workspace", id: "workspace", revision: 0 },
      { kind: "provider", id: "provider", revision: 0 },
    ]);

    const activated = service.activate({ evidenceId: verified.evidenceId, commandId: "store-activate" });
    expect(f.operations.resourceTargets()).toEqual([
      { kind: "workspace", id: "workspace", revision: 1 },
      { kind: "provider", id: "provider", revision: 1 },
    ]);
    expect(f.operations.isReadinessReachable("workspace", "workspace")).toBe(true);
    const receipt = f.operations.operation(activated.operationId)!;
    expect(receipt).toMatchObject({ kind: "activation", requestHash: activationConsumeRequestHash(verified.evidenceId), state: "completed" });
    expect(receipt.result?.activations.map((target) => `${target.kind}:${target.revision}`)).toEqual(["workspace:1", "provider:1"]);
    // Re-running the identical activate command resumes the stored receipt without deciding again.
    const ownerContext = { ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, resourceKeys: [...f.owner.resourceKeys] };
    const replayed = f.operations.commitActivation({
      id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-activate", evidenceOperationId: verified.evidenceId,
      ownerContext, at: ACTIVATION_FIXTURE_NOW, decide: () => { throw new Error("A completed receipt must not decide again"); },
    });
    expect(replayed.kind).toBe("ready");
    if (replayed.kind === "ready") expect(replayed.operation.id).toBe(activated.operationId);

    // Fresh evidence, then a stale CAS token: the revision moved and no resource row changes.
    const second = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "store-verify-2" });
    const payload = parseActivationPayload(f.operations.operation(second.evidenceId)!)!;
    expect(payload.resourceRevisions).toEqual({ workspace: 1, provider: 1 });
    f.operations.withdrawReadiness("workspace", "workspace", { at: ACTIVATION_FIXTURE_NOW, reasonCodes: ["WORKSPACE_NOT_ACTIVATED"] });
    const stale = f.operations.commitActivation({
      id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "store-stale", evidenceOperationId: second.evidenceId, ownerContext, at: ACTIVATION_FIXTURE_NOW,
      decide: () => ({
        activations: [
          { kind: "workspace" as const, id: "workspace", revision: payload.resourceRevisions.workspace, bindingDigest: "d".repeat(64) },
          { kind: "provider" as const, id: "provider", revision: payload.resourceRevisions.provider, bindingDigest: "d".repeat(64) },
        ],
      }),
    });
    expect(stale).toMatchObject({ kind: "invalidated", reasonCodes: ["ACTIVATION_SOURCE_BINDING_CHANGED"] });
    if (stale.kind === "invalidated") expect(stale.operation).toMatchObject({ state: "rejected" });
    expect(f.operations.operation(second.evidenceId)?.state).toBe("ready");
    expect(f.catalog.workspace("workspace")?.state).toBe("needs_verification");
    expect(f.catalog.provider("provider")?.state).toBe("configured");
    noProcesses();
  }, 20000);

  it("settles non-activation outcomes once and refuses a second transition", () => {
    const f = createActivationFixture();
    const ownerContext = { ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, resourceKeys: [...f.owner.resourceKeys] };
    const receipt = f.operations.begin({
      id: newActivationOperationId(), actorId: ACTIVATION_FIXTURE_ACTOR, commandId: "restore-check", kind: "restore_check", requestHash: "restore-hash",
      ownerContext, resourceBinding: { workspaceId: "workspace", providerInstanceId: "provider" },
    });
    f.operations.claim(receipt.id);
    expect(f.operations.settleOutcome(receipt.id, "rejected", { at: ACTIVATION_FIXTURE_NOW, reasonCodes: ["RESTORE_GATE_UNRESOLVED"] }))
      .toMatchObject({ state: "rejected", result: { reasonCodes: ["RESTORE_GATE_UNRESOLVED"] } });
    expect(captureError(() => f.operations.settleOutcome(receipt.id, "outcome_unknown", { at: ACTIVATION_FIXTURE_NOW })))
      .toMatchObject({ code: "ACTIVATION_EVIDENCE_INVALID" });
    expect(f.operations.operation(receipt.id)?.state).toBe("rejected");
    noProcesses();
  }, 20000);
});

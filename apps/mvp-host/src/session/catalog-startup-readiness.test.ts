import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostCatalogReadBindings } from "../catalog/host-catalog.js";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import type { NativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import type { DispatchContext } from "../provider/types.js";
import { RecoveryStore } from "../storage/recovery-store.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn } from "../orchestration/decider.js";
import type { CommandRequest } from "../orchestration/command-contract.js";
import { openOwned } from "../storage/open-store.js";
import { checkoutKey } from "../storage/migrations/007-catalog.js";
import { createCatalogRecoveryBindings, catalogRecoveryConfigurationFingerprint } from "./catalog-recovery.js";
import { inspectCatalogStartupReadiness } from "./catalog-startup-readiness.js";

const close: Array<() => void> = [];
afterEach(() => { for (const stop of close.splice(0).reverse()) stop(); });
const birth: ProcessIdentity = { pid: 123, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "42" } };
const boundary: NativeBoundaryProof = { version: 1, boundaryId: "12345678-1234-1234-1234-123456789abc", platform: "linux", backend: "linux_bubblewrap",
  kernelRelease: "fixture", backendVersion: "fixture", backendDigest: "a".repeat(64), policyDigest: "b".repeat(64), evidenceDigest: "c".repeat(64),
  verifiedPrivateReadBoundary: true, verifiedPrivateWriteBoundary: true, verifiedChildInheritance: true, treeIsolation: "linux_pid_namespace", verifiedDescendantStop: true };
async function fixture() {
  const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner }); close.push(() => { store.close(); owner.release(); });
  const native = vi.fn(() => { throw new Error("Startup readiness must not construct a Provider"); });
  const git = vi.fn(async () => { throw new Error("Startup readiness must not inspect Git"); });
  const host = await createHostCatalogReadBindings({ store, owner, configuration: { workspaces: [{ workspaceId: "workspace", root: "/fixture/checkout/app" }],
    providerInstances: [{ providerInstanceId: "provider", provider: "codex", executable: "/missing-codex" }] }, initialLegacySession: { workspaceId: "workspace", providerInstanceId: "provider" }, runtimeFactory: native, readOnlyGit: git });
  store.setHostIdentityMirror({ hostId: "host", fingerprint: "a".repeat(64) });
  store.createDevice({ id: "actor", hostId: "host", scopes: ["session:read", "session:write"], platform: "test", credentialKind: "browser-session", credentialRevision: 1, createdAt: new Date().toISOString() });
  const sessionId = host.legacySessionId;
  const process = (context: Omit<DispatchContext, "sessionId" | "flyxTurnId"> & Partial<Pick<DispatchContext, "sessionId" | "flyxTurnId">>, id = "original-process", state = "root_exited", identity: ProcessIdentity | null = birth) => {
    store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'process_group',?,'original-journal')`).run(id, context.hostOwnerId, context.hostOwnerGeneration, context.runtimeId, context.runtimeGeneration, context.attemptId, context.sessionId ?? null, context.flyxTurnId ?? null, identity?.pid ?? null, identity?.pid ?? null, state);
    if (identity) {
      store.db.prepare("INSERT INTO managed_process_identities VALUES(?,?)").run(id, JSON.stringify(identity));
      store.db.prepare("INSERT INTO managed_process_boundaries VALUES(?,?,?)").run(id, JSON.stringify(boundary), "d".repeat(64));
    }
  };
  const context: DispatchContext = { hostOwnerId: "original-owner", hostOwnerGeneration: 3, sessionId, flyxTurnId: "original-turn", runtimeId: "original-runtime", runtimeGeneration: 1, attemptId: "original-attempt" };
  const unknown = () => {
    const workspace = host.catalog.workspace("workspace")!;
    host.catalog.putWorkspace({ ...workspace, worktreeRoot: "/fixture/checkout", checkoutKey: checkoutKey("/fixture/checkout") });
    store.acceptTurn({ authSubjectId: "actor", sessionId, turnId: context.flyxTurnId, commandId: "original-command", requestHash: "original-hash", prompt: "original", generation: 1, attemptId: context.attemptId });
    store.db.prepare("UPDATE execution_intents SET dispatch_context_json=? WHERE turn_id=?").run(JSON.stringify(context), context.flyxTurnId);
    new RecoveryStore(store).recordNativeBinding({ context, provider: "codex", providerInstanceId: "provider", nativeSessionId: "original-native", nativeTurnId: "original-native-turn", workspacePath: "/fixture/checkout/app",
      configurationFingerprint: catalogRecoveryConfigurationFingerprint(host.registry.resolve(sessionId)), verifiedVersion: "unknown" });
    process(context);
    store.commitEvent(sessionId, "turn.unknown", { turnId: context.flyxTurnId }, { turnId: context.flyxTurnId, turnStatus: "outcome_unknown", activityState: "outcome_unknown",
      commandReceipt: { authSubjectId: "actor", commandId: "original-command", state: "outcome_unknown", response: { turnId: context.flyxTurnId, status: "outcome_unknown" } } });
    host.catalog.setResidency(sessionId, "blocked");
  };
  const bindings = createCatalogRecoveryBindings({ catalog: host, processInspector: { currentIdentity: () => birth, inspect: () => ({ state: "exited", reason: "original birth exited" }) }, inspectWorkspace: async () => "clear" });
  const acknowledge = async () => {
    const recovery = bindings.recoveryForSession(sessionId)!;
    const evidence = await recovery.inspect({ sessionId, turnId: context.flyxTurnId, attemptId: context.attemptId });
    const operation = await recovery.acknowledge({ authSubjectId: "actor", commandId: "acknowledge-original", sessionId, turnId: context.flyxTurnId, attemptId: context.attemptId,
      evidenceId: evidence.evidenceId, expectedRecoveryRevision: evidence.recoveryRevision, acknowledgeUnknown: true });
    return { evidence, operation };
  };
  const stoppedProof = (id: string, original = birth) => {
    store.db.prepare("UPDATE managed_processes SET state='stopped' WHERE id=?").run(id);
    store.db.prepare("INSERT INTO managed_process_stop_proofs VALUES(?,?)").run(id, JSON.stringify({ kind: "verified-tree-stop", sourceId: boundary.boundaryId + ":" + processIdentityDigest(original),
      identityDigest: processIdentityDigest(original), contractId: "native-boundary/v1/" + boundary.backend + "/" + boundary.evidenceDigest }));
  };
  return { host, store, owner, context, sessionId, native, git, process, unknown, acknowledge, stoppedProof };
}

describe("pure SQL original producer startup readiness", () => {
  it("admits empty SQL10 metadata despite unverified resources and never constructs Native/Git work", async () => {
    const f = await fixture(); const changes = f.store.db.prepare("SELECT total_changes() AS n").get();
    expect(f.host.catalog.workspace("workspace")?.state).toBe("needs_verification");
    expect(f.host.catalog.provider("provider")?.state).toBe("unconfigured");
    expect(inspectCatalogStartupReadiness(f.host)).toEqual({ ready: true, blockers: [] });
    expect(f.store.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes); expect(f.native).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled();
    await f.host.closeAndWait(100); expect(f.host.ready).toBe(false);
    expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).ready).toBe(true);
  });

  it("checks fresh producer facts inside atomic command admission and intent revalidation without blocking a clean owned transaction", async () => {
    const f = await fixture();
    const assertReady = vi.fn(() => {
      expect(f.store.db.inTransaction).toBe(true);
      if (!inspectCatalogStartupReadiness(f.host).ready) throw new Error("HOST_RECOVERY_REQUIRED");
    });
    const request: CommandRequest = { authSubjectId: "actor", commandId: "current-command", method: "session.startTurn", targetSessionId: f.sessionId,
      requestFormatVersion: 2, requestHash: hashCommandRequest("session.startTurn", { prompt: "current" }, { requestFormatVersion: 2, targetSessionId: f.sessionId }),
      dispatchBinding: { hostOwnerId: f.owner.ownerId, hostOwnerGeneration: f.owner.generation, runtimeId: "current-runtime" } };
    const accepted = new CommandEngine(f.store, { admission: assertReady }).commitRequest(request,
      (facts, clock) => decideAcceptTurn(facts, request, { prompt: "current" }, clock));
    expect(f.store.getCommandReceipt("actor", "current-command")?.state).toBe("accepted");
    const execution = new ExecutionStore(f.store), id = accepted.intents[0]!.id;
    execution.claim(id, { id: f.owner.ownerId, generation: f.owner.generation }, assertReady);
    execution.transition({ id, expectedStates: ["claimed"], state: "dispatching" }, assertReady);
    expect(execution.get(id)?.state).toBe("dispatching"); expect(assertReady).toHaveBeenCalledTimes(3);
    f.process({ hostOwnerId: "unresolved-owner", hostOwnerGeneration: 5, runtimeId: "unresolved-query", runtimeGeneration: 1, attemptId: "unresolved-attempt" }, "newly-observed-helper", "unknown", null);
    expect(() => execution.transition({ id, expectedStates: ["dispatching"], state: "acknowledged" }, assertReady)).toThrow("HOST_RECOVERY_REQUIRED");
    expect(execution.get(id)?.state).toBe("dispatching");
    expect(f.store.getCommandReceipt("actor", "current-command")?.state).toBe("accepted");
    expect(f.native).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled();
  });

  it("recognizes committed full-tree stop plus explicit acknowledgment while preserving unknown Turn/receipt/intent history", async () => {
    const f = await fixture(); f.unknown();
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
    const { operation } = await f.acknowledge(); expect(operation.gate).toBe("released");
    const before = f.store.getTurn(f.context.flyxTurnId); const receipt = f.store.getCommandReceipt("actor", "original-command");
    expect(inspectCatalogStartupReadiness(f.host)).toEqual({ ready: true, blockers: [] });
    expect(f.store.getTurn(f.context.flyxTurnId)).toEqual(before); expect(before?.status).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("actor", "original-command")).toEqual(receipt); expect(receipt?.state).toBe("outcome_unknown");
    f.store.db.prepare("UPDATE execution_intents SET state='outcome_unknown' WHERE turn_id=?").run(f.context.flyxTurnId);
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(true);
    expect(f.store.db.prepare("SELECT state FROM execution_intents WHERE turn_id=?").get(f.context.flyxTurnId)).toEqual({ state: "outcome_unknown" });
    await f.host.closeAndWait(100); expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).ready).toBe(true);
  });

  it("keeps an original release valid after an independently stopped later Turn advances the Session", async () => {
    const f = await fixture(); f.unknown(); await f.acknowledge();
    const next = { ...f.context, flyxTurnId: "later-turn", attemptId: "later-attempt", runtimeId: "later-runtime", runtimeGeneration: 2 };
    f.store.acceptTurn({ authSubjectId: "actor", sessionId: f.sessionId, turnId: next.flyxTurnId, commandId: "later-command", requestHash: "later-hash", prompt: "later", generation: 2, attemptId: next.attemptId });
    f.store.db.prepare("UPDATE execution_intents SET dispatch_context_json=? WHERE turn_id=?").run(JSON.stringify(next), next.flyxTurnId);
    f.process(next, "later-process", "not_spawned", null);
    f.store.commitEvent(f.sessionId, "turn.failed", { turnId: next.flyxTurnId }, { turnId: next.flyxTurnId, turnStatus: "failed", activityState: "idle", commandReceipt: { authSubjectId: "actor", commandId: "later-command", state: "failed", response: { turnId: next.flyxTurnId, status: "failed", evidence: { kind: "not-dispatched" } } } });
    expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).ready).toBe(true);
    expect(f.store.getTurn(f.context.flyxTurnId)?.status).toBe("outcome_unknown");
  });

  it.each(["owner-generation", "attempt", "birth", "boundary", "launch-digest", "recovery-source", "receipt", "configuration", "checkout", "intent-fence"])("rejects changed original %s proof after release", async (changed) => {
    const f = await fixture(); f.unknown(); const { operation } = await f.acknowledge();
    if (changed === "owner-generation") f.store.db.prepare("UPDATE managed_processes SET owner_generation=4").run();
    if (changed === "intent-fence") f.store.db.prepare("UPDATE execution_intents SET dispatch_context_json=?").run(JSON.stringify({ ...f.context, runtimeId: "different-runtime" }));
    if (changed === "attempt") f.store.db.prepare("UPDATE managed_processes SET attempt_id='different-attempt'").run();
    if (changed === "birth") f.store.db.prepare("UPDATE managed_process_identities SET identity_json=?").run(JSON.stringify({ ...birth, birth: { ...birth.birth!, startTicks: "43" } }));
    if (changed === "boundary") f.store.db.prepare("UPDATE managed_process_boundaries SET proof_json=?").run(JSON.stringify({ ...boundary, treeIsolation: "unverified", verifiedDescendantStop: false }));
    if (changed === "launch-digest") f.store.db.prepare("UPDATE managed_process_boundaries SET launch_digest=?").run("e".repeat(64));
    if (changed === "recovery-source") f.store.db.prepare("UPDATE session_events SET payload_json='{}' WHERE type='turn.recovery.acknowledged'").run();
    if (changed === "receipt") f.store.db.prepare("UPDATE command_receipts SET response_json='{}' WHERE command_id='acknowledge-original'").run();
    if (changed === "configuration") f.host.catalog.putProvider({ ...f.host.catalog.provider("provider")!, config: { ...f.host.catalog.provider("provider")!.config, model: "changed" } });
    if (changed === "checkout") f.host.catalog.putWorkspace({ ...f.host.catalog.workspace("workspace")!, worktreeRoot: "/different/checkout", checkoutKey: checkoutKey("/different/checkout") });
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
    expect(f.store.getSession(f.sessionId)).toMatchObject({ recoveryState: "idle", recoveryRevision: operation.recoveryRevision });
    expect(f.store.getTurn(f.context.flyxTurnId)?.status).toBe("outcome_unknown");
  });

  it.each(["helper", "missing-inventory", "legacy"])("blocks %s history without usable original launch coverage", async (kind) => {
    const f = await fixture(); f.unknown(); await f.acknowledge();
    if (kind === "helper") f.process({ hostOwnerId: f.context.hostOwnerId, hostOwnerGeneration: 3, runtimeId: "original-query", runtimeGeneration: 1, attemptId: "helper-attempt" }, "unbound-helper", "unknown", null);
    if (kind === "missing-inventory") {
      f.store.db.prepare("DELETE FROM managed_process_boundaries").run(); f.store.db.prepare("DELETE FROM managed_process_identities").run(); f.store.db.prepare("DELETE FROM managed_processes").run();
    }
    if (kind === "legacy") f.store.db.prepare("UPDATE turns SET attempt_id=NULL WHERE id=?").run(f.context.flyxTurnId);
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
  });

  it("ignores known current work for business readiness but blocks it at final shutdown and always blocks unknown", async () => {
    const f = await fixture(); const local = { hostOwnerId: f.owner.ownerId, hostOwnerGeneration: f.owner.generation, runtimeId: "current-query", runtimeGeneration: 1, attemptId: "current-attempt" };
    f.process(local, "current-query", "running");
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(true);
    expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).blockers).toContain("ORIGINAL_PROCESS_STOP_UNVERIFIED");
    f.store.db.prepare("UPDATE managed_processes SET state='unknown' WHERE id='current-query'").run();
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
    f.stoppedProof("current-query"); expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).ready).toBe(true);
  });

  it("permits an exact current queued Turn until it becomes unknown, and checks it during final shutdown", async () => {
    const f = await fixture(); const local: DispatchContext = { hostOwnerId: f.owner.ownerId, hostOwnerGeneration: f.owner.generation, sessionId: f.sessionId,
      flyxTurnId: "current-turn", runtimeId: "current-runtime", runtimeGeneration: 1, attemptId: "current-turn-attempt" };
    f.store.acceptTurn({ authSubjectId: "actor", sessionId: f.sessionId, turnId: local.flyxTurnId, commandId: "current-command", requestHash: "current-hash", prompt: "current", generation: 1, attemptId: local.attemptId });
    f.store.db.prepare("UPDATE execution_intents SET dispatch_context_json=? WHERE turn_id=?").run(JSON.stringify(local), local.flyxTurnId);
    f.process(local, "current-turn-process", "launching", null);
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(true);
    expect(inspectCatalogStartupReadiness(f.host, { includeCurrentOwner: true }).blockers).toContain("ORIGINAL_SESSION_GATE_UNRESOLVED");
    f.store.commitEvent(f.sessionId, "turn.unknown", { turnId: local.flyxTurnId }, { turnId: local.flyxTurnId, turnStatus: "outcome_unknown", activityState: "outcome_unknown" });
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("ORIGINAL_SESSION_GATE_UNRESOLVED");
    expect(f.native).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled();
  });

  it("requires birth and verified descendant boundary for stopped query/helper rows without a Session", async () => {
    const f = await fixture(); const original = { hostOwnerId: "earlier-owner", hostOwnerGeneration: 4, runtimeId: "original-query", runtimeGeneration: 1, attemptId: "original-query-attempt" };
    f.process(original, "helper", "root_exited"); expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
    f.stoppedProof("helper"); expect(inspectCatalogStartupReadiness(f.host).ready).toBe(true);
    f.store.db.prepare("UPDATE managed_process_identities SET identity_json=?").run(JSON.stringify({ pid: 123, platform: "darwin" }));
    expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false);
  });

  it("never treats a cleared active pointer as proof for recovery, close or generic operation gates", async () => {
    const f = await fixture(); f.unknown(); const { operation } = await f.acknowledge();
    f.store.db.prepare("UPDATE sessions SET recovery_state='blocked',recovery_revision=recovery_revision+1 WHERE id=?").run(f.sessionId);
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("ORIGINAL_SESSION_GATE_UNRESOLVED");
    f.store.db.prepare("UPDATE sessions SET recovery_state='idle' WHERE id=?").run(f.sessionId);
    f.store.db.prepare("INSERT INTO catalog_runtime_operations VALUES('close',?,'actor','close-command','close-hash',2,?,NULL,'outcome_unknown','now','now')").run(f.sessionId, JSON.stringify({ ownerId: f.context.hostOwnerId, ownerGeneration: f.context.hostOwnerGeneration }));
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("CATALOG_RUNTIME_CLOSE_UNRESOLVED");
    f.store.db.prepare("DELETE FROM catalog_runtime_operations").run();
    f.store.db.prepare("INSERT INTO checkpoint_captures VALUES('capture',?,'workspace',NULL,NULL,'manual','capturing','workspace-ref','index-ref','{}','now',NULL)").run(f.sessionId);
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("CHECKPOINT_CAPTURE_UNRESOLVED");
    f.store.db.prepare("UPDATE checkpoint_captures SET status='failed'").run();
    f.store.db.prepare("INSERT INTO managed_worktrees VALUES('worktree','repository','workspace','blocked',0,'{}')").run();
    f.store.db.prepare("INSERT INTO worktree_operations VALUES('worktree-operation','actor','worktree-command','worktree','create','outcome_unknown','dispatch','hash','{}','{}',NULL,'now','now')").run();
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("WORKTREE_OPERATION_UNRESOLVED");
    f.store.db.prepare("DELETE FROM worktree_operations").run(); f.store.db.prepare("DELETE FROM managed_worktrees").run();
    f.store.db.prepare("UPDATE recovery_operations SET phase='checking' WHERE id=?").run(operation.operationId);
    expect(inspectCatalogStartupReadiness(f.host).blockers).toContain("RECOVERY_OPERATION_UNRESOLVED");
    f.store.db.transaction(() => { expect(inspectCatalogStartupReadiness(f.host).ready).toBe(false); })();
  });
});

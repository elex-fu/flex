import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../storage/db.js";
import { RecoveryService } from "./recovery-service.js";
import { RecoveryStore, digest } from "../storage/recovery-store.js";
import type { ExecutionRecoveryObservation, RecoveryCommandInput } from "../storage/recovery-store.js";
import type { DispatchContext } from "../provider/types.js";
import type { NativeTurnObservation } from "../provider/native-history.js";

const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const clockStart = Date.parse("2026-10-15T00:00:00Z");
function terminal(nativeTurnId = "native-turn"): NativeTurnObservation {
  return { state: "terminal", nativeSessionId: "native-session", nativeTurnId, status: "completed",
    evidence: { kind: "native-terminal", sourceId: "native-terminal-source", verifiedVersion: "fixture-verified" } };
}
function stopped(): ExecutionRecoveryObservation {
  return { state: "stopped", workspaceState: "clear", evidence: { kind: "process-tree-stopped", sourceId: "tree-stop-source",
    ownerId: "original-owner", ownerGeneration: 2, resourceKeys: ["db:key", "identity:key", "workspace:key"] } };
}
function fixture(options: { native?: NativeTurnObservation; execution?: ExecutionRecoveryObservation; defaultExecution?: boolean; legacy?: boolean } = {}) {
  const store = new SqliteStore(); stores.push(store);
  const session = store.createSession("/fixture/workspace", "codex");
  const accepted = options.legacy
    ? { turn: store.createTurn({ sessionId: session.id, turnId: "original-turn", commandId: "original-command", requestHash: "original-hash", prompt: "original", generation: 1 }) }
    : store.acceptTurn({ authSubjectId: "device", sessionId: session.id, turnId: "original-turn", commandId: "original-command", requestHash: "original-hash", prompt: "original", generation: 1, attemptId: "original-attempt" });
  const context: DispatchContext = { hostOwnerId: "original-owner", hostOwnerGeneration: 2, sessionId: session.id,
    flyxTurnId: "original-turn", runtimeId: "original-runtime", runtimeGeneration: 1, attemptId: "original-attempt" };
  const recovery = new RecoveryStore(store);
  if (!options.legacy) {
    recovery.recordNativeBinding({ context, provider: "codex", providerInstanceId: "codex-instance", nativeSessionId: "native-session", nativeTurnId: "native-turn",
      workspacePath: "/fixture/workspace", configurationFingerprint: "fixture-policy", verifiedVersion: "fixture-verified" });
    store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
      VALUES('process-original','original-owner',2,'original-runtime',1,'original-attempt',?,'original-turn',123,123,'process_group','root_exited',?)`).run(session.id, new Date(clockStart).toISOString());
  }
  store.commitEvent(session.id, "turn.unknown", { turnId: accepted.turn.id }, { turnId: accepted.turn.id, turnStatus: "outcome_unknown", activityState: "outcome_unknown",
    ...(!options.legacy ? { commandReceipt: { authSubjectId: "device", commandId: "original-command", requestHash: "original-hash", state: "outcome_unknown" as const, response: { turnId: accepted.turn.id, status: "outcome_unknown" }, required: true } } : {}) });
  let timestamp = clockStart;
  let native = options.native ?? terminal();
  let execution = options.execution ?? stopped();
  let nativeReads = 0;
  let nativeBarrier: Promise<void> | undefined;
  const service = new RecoveryService({ store, now: () => new Date(timestamp).toISOString(),
    ...(!options.defaultExecution ? { inspectExecution: async () => execution } : {}),
    inspectNative: async () => { nativeReads += 1; if (nativeBarrier) await nativeBarrier; return native; } });
  const inspect = () => service.inspect({ sessionId: session.id, turnId: accepted.turn.id, ...(accepted.turn.attemptId ? { attemptId: accepted.turn.attemptId } : {}) });
  const input = (view: Awaited<ReturnType<typeof inspect>>, commandId = "recovery-command"): RecoveryCommandInput => ({ authSubjectId: "device", commandId,
    sessionId: session.id, turnId: accepted.turn.id, ...(accepted.turn.attemptId ? { attemptId: accepted.turn.attemptId } : {}), evidenceId: view.evidenceId, expectedRecoveryRevision: view.recoveryRevision });
  return { store, service, recovery, session, context, inspect, input, setNative(value: NativeTurnObservation) { native = value; },
    setExecution(value: ExecutionRecoveryObservation) { execution = value; }, setTime(value: number) { timestamp = value; },
    holdNative(value: Promise<void> | undefined) { nativeBarrier = value; }, get nativeReads() { return nativeReads; } };
}
function nextTurn(f: ReturnType<typeof fixture>, id = "new-turn") {
  return f.store.acceptTurn({ authSubjectId: "device", sessionId: f.session.id, turnId: id, commandId: `command-${id}`,
    requestHash: `hash-${id}`, prompt: "new prompt", generation: 2, attemptId: `attempt-${id}` });
}

function addControlIntent(f: ReturnType<typeof fixture>) {
  f.store.commitCommand({ sessionId: f.session.id, build: () => ({ result: undefined,
    receipts: [{ authSubjectId: "device", commandId: "interrupt-command", method: "session.interrupt", requestHash: "interrupt-hash", targetSessionId: f.session.id,
      requestFormatVersion: 2, state: "outcome_unknown", response: { turnId: "original-turn", status: "outcome_unknown" } }],
    events: [{ type: "interrupt.unknown", payload: { turnId: "original-turn" } }],
    intents: [{ id: "interrupt-intent", sessionId: f.session.id, turnId: "original-turn", authSubjectId: "device", commandId: "interrupt-command", ordinal: 0,
      actorKind: "device", kind: "interrupt_turn", resourceId: "original-turn", payload: { turnId: "original-turn" }, requestHash: "interrupt-hash",
      requestFormatVersion: 2, runtimeGeneration: 1, attemptId: "original-attempt" }] }) });
}

describe("recovery observation lifecycle", () => {
  it.each(["reconcile", "acknowledge"] as const)("accounts for every stopped same-owner inspection helper across inspect and %s", async (action) => {
    const f = fixture(); let launches = 0;
    const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(),
      inspectExecution: async (target) => {
        expect(target.ownerProcesses.map((record) => record.id)).toEqual(["process-original"]);
        return { ...stopped(), evidence: { ...stopped().evidence!, processRecordIds: target.ownerProcesses.map((record) => record.id) } };
      },
      inspectNative: async () => {
        const id = `inspection-${++launches}`;
        f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
          VALUES(?,'original-owner',2,?,1,?,?,'original-turn',?,?,'process_group','stopped','now')`)
          .run(id, `inspection-runtime-${launches}`, `inspection-attempt-${launches}`, f.session.id, 200 + launches, 200 + launches);
        const business: NativeTurnObservation = action === "reconcile" ? terminal() : { state: "unknown", reason: "original_result_unknown" };
        return { ...business, inspectionExecution: { version: 1, state: "stopped", originalContextDigest: digest(f.context),
          helpers: [{ launchId: id, launchDigest: digest(id), processRecordIds: [id], sourceId: `fixture-stop:${id}`, contractId: "fixture-full-tree-v1" }] } };
      },
      verifyNativeInspectionEvidence: (handle, evidence) => evidence.state === "stopped" && evidence.originalContextDigest === digest(handle.context)
        && evidence.helpers.every((helper) => helper.launchDigest === digest(helper.launchId) && helper.sourceId === `fixture-stop:${helper.launchId}` && helper.contractId === "fixture-full-tree-v1"
          && helper.processRecordIds.length === 1 && helper.processRecordIds[0] === helper.launchId
          && !!f.store.db.prepare("SELECT 1 FROM managed_processes WHERE id=? AND owner_id='original-owner' AND owner_generation=2 AND state='stopped' AND session_id=? AND turn_id='original-turn' AND runtime_id <> 'original-runtime'").get(helper.launchId, f.session.id)),
    });
    const view = await service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" });
    expect(view.processState).toBe("stopped");
    const input = { ...f.input(view), commandId: `same-owner-${action}` };
    const result = action === "reconcile" ? await service.reconcile(input) : await service.acknowledge({ ...input, acknowledgeUnknown: true });
    expect(result).toMatchObject({ state: "completed", gate: "released" }); expect(launches).toBe(2);
    const journal = service.recovery.operation(result.operationId)!;
    expect(journal.evidenceId).not.toBe(view.evidenceId);
    const final = service.recovery.evidence(journal.evidenceId)!;
    expect(final.native.inspectionExecution?.helpers.map((helper) => helper.launchId)).toEqual(["inspection-1", "inspection-2"]);
    const proof = service.recovery.releaseProof(journal.evidenceId)!;
    expect(service.recovery.verifyReleaseProof(proof, { ownerId: "original-owner", ownerGeneration: 2, resourceKey: "db:key", purpose: "host" })).toBe(true);
    f.store.db.prepare("UPDATE managed_processes SET state='running' WHERE id='inspection-1'").run();
    expect(service.recovery.verifyReleaseProof(proof, { ownerId: "original-owner", ownerGeneration: 2, resourceKey: "db:key", purpose: "host" })).toBe(false);
  });
  it("reuses persisted same-owner helper stop evidence to release recovery without another helper launch", async () => {
    const f = fixture(); let launches = 0; let nativeReads = 0; const executions: string[][] = [];
    const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(),
      inspectExecution: async (target) => { executions.push(target.ownerProcesses.map((record) => record.id));
        return { ...stopped(), evidence: { ...stopped().evidence!, processRecordIds: target.ownerProcesses.map((record) => record.id) } }; },
      inspectNative: async () => {
        nativeReads += 1;
        if (launches) return terminal(); // A later read needs no new helper: the saved one carries the durable stop proof.
        const id = `inspection-${++launches}`;
        f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
          VALUES(?,'original-owner',2,?,1,?,?,'original-turn',?,?,'process_group','stopped','now')`)
          .run(id, `inspection-runtime-${launches}`, `inspection-attempt-${launches}`, f.session.id, 200 + launches, 200 + launches);
        return { ...terminal(), inspectionExecution: { version: 1, state: "stopped", originalContextDigest: digest(f.context),
          helpers: [{ launchId: id, launchDigest: digest(id), processRecordIds: [id], sourceId: `fixture-stop:${id}`, contractId: "fixture-full-tree-v1" }] } };
      },
      verifyNativeInspectionEvidence: (handle, evidence) => evidence.state === "stopped" && evidence.originalContextDigest === digest(handle.context)
        && evidence.helpers.every((helper) => helper.launchDigest === digest(helper.launchId) && helper.sourceId === `fixture-stop:${helper.launchId}` && helper.contractId === "fixture-full-tree-v1"
          && helper.processRecordIds.length === 1 && helper.processRecordIds[0] === helper.launchId
          && !!f.store.db.prepare("SELECT 1 FROM managed_processes WHERE id=? AND owner_id='original-owner' AND owner_generation=2 AND state='stopped' AND session_id=? AND turn_id='original-turn' AND runtime_id <> 'original-runtime'").get(helper.launchId, f.session.id)),
    });
    const view = await service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" });
    expect(view.processState).toBe("stopped");
    const result = await service.reconcile(f.input(view));
    expect(result).toMatchObject({ state: "completed", gate: "released" });
    // The prior helper was never re-spawned; its persisted stop evidence covered the whole re-inspection.
    expect(launches).toBe(1); expect(nativeReads).toBe(2);
    expect(executions).toEqual([["process-original"], ["process-original"]]);
    const final = service.recovery.evidence(service.recovery.operation(result.operationId)!.evidenceId)!;
    expect(final.native.inspectionExecution?.helpers.map((helper) => helper.launchId)).toEqual(["inspection-1"]);
    expect(f.store.db.prepare("SELECT id FROM managed_processes WHERE runtime_id <> 'original-runtime' ORDER BY id").all()).toEqual([{ id: "inspection-1" }]);
    expect(f.recovery.releaseProof(final.view.evidenceId)).toBeDefined();
  });
  it("rejects re-inspection and never spawns a replacement helper when a saved helper stop proof is missing", async () => {
    const f = fixture(); let launches = 0; let nativeReads = 0;
    const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(),
      inspectExecution: async (target) => ({ ...stopped(), evidence: { ...stopped().evidence!, processRecordIds: target.ownerProcesses.map((record) => record.id) } }),
      inspectNative: async () => {
        nativeReads += 1;
        const id = `inspection-${++launches}`;
        f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
          VALUES(?,'original-owner',2,?,1,?,?,'original-turn',?,?,'process_group','stopped','now')`)
          .run(id, `inspection-runtime-${launches}`, `inspection-attempt-${launches}`, f.session.id, 200 + launches, 200 + launches);
        return { ...terminal(), inspectionExecution: { version: 1, state: "stopped", originalContextDigest: digest(f.context),
          helpers: [{ launchId: id, launchDigest: digest(id), processRecordIds: [id], sourceId: `fixture-stop:${id}`, contractId: "fixture-full-tree-v1" }] } };
      },
      verifyNativeInspectionEvidence: (handle, evidence) => evidence.state === "stopped" && evidence.originalContextDigest === digest(handle.context)
        && evidence.helpers.every((helper) => helper.launchDigest === digest(helper.launchId) && helper.sourceId === `fixture-stop:${helper.launchId}` && helper.contractId === "fixture-full-tree-v1"
          && helper.processRecordIds.length === 1 && helper.processRecordIds[0] === helper.launchId
          && !!f.store.db.prepare("SELECT 1 FROM managed_processes WHERE id=? AND owner_id='original-owner' AND owner_generation=2 AND state='stopped' AND session_id=? AND turn_id='original-turn' AND runtime_id <> 'original-runtime'").get(helper.launchId, f.session.id)),
    });
    const view = await service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" });
    expect(view.processState).toBe("stopped");
    expect(launches).toBe(1); expect(nativeReads).toBe(1);
    // The durable stop record of the saved helper disappears (it may never have stopped).
    f.store.db.prepare("UPDATE managed_processes SET state='running' WHERE id='inspection-1'").run();
    await expect(service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" })).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    // Fail-closed before any new inspection helper launch, and nothing was re-spawned or released.
    expect(nativeReads).toBe(1); expect(launches).toBe(1);
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM managed_processes WHERE runtime_id <> 'original-runtime'").get()).toEqual({ count: 1 });
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM recovery_evidence").get()).toEqual({ count: 1 });
    const proof = f.recovery.releaseProof(view.evidenceId)!;
    expect(f.recovery.verifyReleaseProof(proof, { resourceKey: "workspace:key", ownerId: "original-owner", ownerGeneration: 2, purpose: "workspace:original-turn" })).toBe(false);
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
  });
  it("rejects an unrelated same-owner successor rather than excluding it as an inspection helper", async () => {
    const f = fixture();
    const service = new RecoveryService({ store: f.store, inspectExecution: async () => stopped(), inspectNative: async () => {
      f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
        VALUES('unrelated','original-owner',2,'unrelated-runtime',1,'unrelated-attempt',?,'original-turn',333,333,'process_group','running','now')`).run(f.session.id);
      return terminal();
    } });
    await expect(service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" })).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    expect(f.store.db.prepare("SELECT 1 FROM recovery_evidence").get()).toBeUndefined();
  });
  it("never acknowledges original stopped execution while an inspection helper stop is unknown", async () => {
    const f = fixture({ native: { state: "unknown", reason: "native_history_helper_stop_unverified" }, execution: stopped() });
    const view = await f.inspect();
    expect(view).toMatchObject({ processState: "unknown", workspaceState: "unknown", nativeState: "unknown" });
    expect(view.nextSteps).not.toContain("acknowledge");
    await expect(f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true })).resolves.toMatchObject({ gate: "blocked", state: "blocked" });
    expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
  });
  it("blocks typed successor stop evidence when its durable verifier is absent", async () => {
    const f = fixture({ execution: stopped() });
    f.setNative({ state: "unknown", reason: "native_result_unreadable", inspectionExecution: {
      version: 1, state: "stopped", originalContextDigest: digest(f.context), helpers: [{ launchId: "helper", launchDigest: "a".repeat(64), processRecordIds: ["current-owner-helper"], sourceId: "stop", contractId: "tree-stop-v1" }],
    } });
    expect(await f.inspect()).toMatchObject({ processState: "unknown", workspaceState: "unknown" });
  });
  it("rejects original target changes while a native inspection is pending", async () => {
    const f = fixture(); let release!: () => void; f.holdNative(new Promise<void>((yes) => { release = yes; }));
    const execution = vi.fn(async () => stopped());
    const service = new RecoveryService({ store: f.store, inspectExecution: execution, inspectNative: async () => { await new Promise<void>((yes) => { release = yes; }); return terminal(); } });
    const pending = service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" });
    const denied = expect(pending).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    f.store.db.prepare("UPDATE native_turn_bindings SET native_turn_id='changed',revision=revision+1 WHERE turn_id='original-turn'").run();
    release(); await denied; expect(execution).not.toHaveBeenCalled();
    expect(f.store.db.prepare("SELECT 1 FROM recovery_evidence").get()).toBeUndefined();
  });
  it("seals a deferred inspect before Store close without any late evidence SQL", async () => {
    const f = fixture(); let release!: () => void;
    f.holdNative(new Promise<void>((yes) => { release = yes; }));
    const saved = vi.spyOn(f.service.recovery, "saveEvidence");
    const pending = f.inspect(); const rejected = expect(pending).rejects.toMatchObject({ code: "RECOVERY_CLOSED" });
    f.service.seal(); const sql = vi.spyOn(f.store.db, "prepare"); f.store.close(); release();
    await rejected; expect(sql).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
  });

  it.each(["reconcile", "acknowledge"] as const)("keeps the accepted %s marker when sealed observation completes after Store close", async (action) => {
    const f = fixture({ native: action === "acknowledge" ? { state: "unknown", reason: "original result unknown" } : terminal() });
    const view = await f.inspect(); let release!: () => void;
    f.holdNative(new Promise<void>((yes) => { release = yes; }));
    const pending = action === "acknowledge" ? f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true }) : f.service.reconcile(f.input(view));
    const rejected = expect(pending).rejects.toMatchObject({ code: "RECOVERY_CLOSED" });
    expect(f.recovery.operationForCommand("device", "recovery-command")?.phase).toBe("checking");
    const finish = vi.spyOn(f.service.recovery, "finishOperation"); const fail = vi.spyOn(f.service.recovery, "failOperation");
    f.service.seal(); const sql = vi.spyOn(f.store.db, "prepare"); f.store.close(); release(); await rejected;
    expect(sql).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  });

  it("rejects new requests during drain while the admitted original recovery can commit", async () => {
    const f = fixture(); const view = await f.inspect(); let release!: () => void;
    f.holdNative(new Promise<void>((yes) => { release = yes; }));
    const pending = f.service.reconcile(f.input(view)); f.service.beginDrain();
    await expect(f.inspect()).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    await expect(f.service.reconcile(f.input(view, "new-request"))).rejects.toMatchObject({ code: "RECOVERY_DRAINING" });
    release(); await expect(pending).resolves.toMatchObject({ gate: "released" });
    expect(f.store.getCommandReceipt("device", "new-request")).toBeUndefined();
  });
});

describe("evidence-bound original execution recovery", () => {
  it("settles exact native terminal proof, original/control receipts and intents through one Engine commit", async () => {
    const f = fixture(); addControlIntent(f);
    const view = await f.inspect();
    expect(view).toMatchObject({ nativeState: "terminal", nativeOutcome: "completed", processState: "stopped", workspaceState: "clear" });
    const result = await f.service.reconcile(f.input(view));
    expect(result).toMatchObject({ state: "completed", gate: "released", turnStatus: "completed" });
    expect(f.store.getTurn("original-turn")?.status).toBe("completed");
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("completed");
    expect(f.store.getCommandReceipt("device", "interrupt-command")?.response).toMatchObject({ disposition: "obsolete_after_execution_stopped", deliveryState: "unconfirmed" });
    expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("completed");
    expect(f.store.db.prepare("SELECT state FROM execution_intents WHERE turn_id = 'original-turn'").all()).toEqual([expect.objectContaining({ state: "settled" }), expect.objectContaining({ state: "settled" })]);
    expect(f.store.getActiveTurn(f.session.id)).toBeUndefined();
    expect(f.store.getSession(f.session.id)).toMatchObject({ activityState: "idle", recoveryState: "idle", recoveryRevision: result.recoveryRevision });
    const again = await f.service.reconcile(f.input(view));
    expect(again).toEqual(result);
    expect(f.nativeReads).toBe(2);
  });

  it("settles a native result without releasing the gate when process identity/descendants are unknown", async () => {
    const f = fixture({ defaultExecution: true });
    const view = await f.inspect();
    expect(view).toMatchObject({ nativeState: "terminal", processState: "unknown", workspaceState: "unknown" });
    const result = await f.service.reconcile(f.input(view));
    expect(result).toMatchObject({ state: "completed", turnStatus: "completed", gate: "blocked" });
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("completed");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
    expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
    expect(() => nextTurn(f)).toThrow("RECOVERY_BLOCKED");
    expect(f.recovery.releaseProof(view.evidenceId)).toBeUndefined();
    f.setExecution(stopped());
    const service = new RecoveryService({ store: f.store, inspectExecution: async () => stopped(), inspectNative: async () => terminal(), now: () => new Date(clockStart).toISOString() });
    const fresh = await service.inspect({ sessionId: f.session.id, turnId: "original-turn", attemptId: "original-attempt" });
    await expect(service.reconcile(f.input(fresh, "release-after-stop"))).resolves.toMatchObject({ gate: "released", turnStatus: "completed" });
  });

  it("requires explicit acknowledgment after known tree stop and preserves unknown history when a new prompt starts", async () => {
    const f = fixture({ native: { state: "unknown", reason: "no_native_terminal" } });
    const view = await f.inspect();
    expect(view.nextSteps).toContain("acknowledge");
    await expect(f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true })).resolves.toMatchObject({ gate: "released", turnStatus: "outcome_unknown" });
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("device", "original-command")).toMatchObject({ state: "outcome_unknown", response: { acknowledged: true, executionStopped: true } });
    expect(f.store.db.prepare("SELECT state,result_code FROM execution_intents WHERE kind = 'start_turn'").get()).toMatchObject({ state: "settled", result_code: "outcome_unknown_acknowledged" });
    const accepted = nextTurn(f);
    expect(f.store.getSnapshot(f.session.id)?.activeTurn?.id).toBe(accepted.turn.id);
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 2 });
  });

  it.each(["unknown", "running"] as const)("keeps %s process identity blocked without replaying or inventing an outcome", async (state) => {
    const f = fixture({ native: { state: "unknown", reason: "unverifiable" }, execution: { state, workspaceState: "held", reason: "identity_unverified" } });
    const view = await f.inspect();
    expect(view.nextSteps).not.toContain("acknowledge");
    await expect(f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true })).resolves.toMatchObject({ state: "blocked", gate: "blocked" });
    expect(() => nextTurn(f)).toThrow("RECOVERY_BLOCKED");
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("outcome_unknown");
    expect(f.store.db.prepare("SELECT state FROM execution_intents WHERE kind = 'start_turn'").get()).toEqual({ state: "outcome_unknown" });
  });

  it("does not upgrade SDK/legacy history without a verifiable original attempt", async () => {
    const f = fixture({ legacy: true });
    const view = await f.inspect();
    expect(view).toMatchObject({ nativeState: "unknown", processState: "unknown" });
    expect(view.attemptId).toBeUndefined();
    await expect(f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true })).resolves.toMatchObject({ state: "blocked" });
    expect(() => nextTurn(f)).toThrow("RECOVERY_BLOCKED");
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
  });

  it("rejects a terminal observation for another native Turn", async () => {
    const f = fixture({ native: terminal("latest-but-wrong-turn") });
    const view = await f.inspect();
    expect(view.nativeState).toBe("unknown");
    await expect(f.service.reconcile(f.input(view))).resolves.toMatchObject({ state: "blocked" });
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
  });

  it("reconciles historical unknown evidence without changing a newer active Turn", async () => {
    const f = fixture({ native: { state: "unknown", reason: "no_terminal_yet" } });
    const view = await f.inspect();
    await f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true });
    nextTurn(f);
    f.setNative(terminal());
    const historical = await f.inspect();
    await expect(f.service.reconcile(f.input(historical, "historical-reconcile"))).resolves.toMatchObject({ gate: "unchanged", turnStatus: "completed" });
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("new-turn");
    expect(f.store.getSession(f.session.id)?.activityState).toBe("running");
    expect(f.store.getTurn("new-turn")?.status).toBe("queued");
    expect(f.store.getCommandReceipt("device", "command-new-turn")?.state).toBe("accepted");
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("completed");
  });

  it("exposes an accepted marker while read-only inspection is pending, then updates its receipt", async () => {
    const f = fixture();
    const view = await f.inspect();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.holdNative(barrier);
    const result = f.service.reconcile(f.input(view));
    expect(f.recovery.operationForCommand("device", "recovery-command")?.phase).toBe("checking");
    expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("accepted");
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("outcome_unknown");
    release();
    await result;
    expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("completed");
  });

  it.each(["expired", "revision", "changed-inspection"])("rejects %s evidence without releasing the original execution", async (cause) => {
    const f = fixture();
    const view = await f.inspect();
    if (cause === "expired") f.setTime(clockStart + 30_001);
    if (cause === "revision") f.store.db.prepare("UPDATE sessions SET recovery_revision = recovery_revision + 1 WHERE id = ?").run(f.session.id);
    if (cause === "changed-inspection") f.setExecution({ state: "unknown", workspaceState: "unknown", reason: "process_identity_changed" });
    await expect(f.service.reconcile(f.input(view))).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
    if (cause === "changed-inspection") expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("failed");
    else expect(f.store.getCommandReceipt("device", "recovery-command")).toBeUndefined();
  });

  it("rolls back marker/receipt/events if the operation journal insert fails before inspection", async () => {
    const f = fixture();
    const view = await f.inspect();
    const before = f.store.getSession(f.session.id)!;
    f.store.db.exec("CREATE TRIGGER fail_recovery_marker BEFORE INSERT ON recovery_operations BEGIN SELECT RAISE(ABORT,'injected recovery journal failure'); END");
    await expect(f.service.reconcile(f.input(view))).rejects.toThrow("injected recovery journal failure");
    expect(f.store.getCommandReceipt("device", "recovery-command")).toBeUndefined();
    expect(f.store.getSession(f.session.id)).toEqual(before);
    expect(f.nativeReads).toBe(1);
  });

  it("rolls back native terminal/gate/receipt/intent settlement if the final journal commit fails", async () => {
    const f = fixture(); addControlIntent(f);
    const view = await f.inspect();
    f.store.db.exec("CREATE TRIGGER fail_recovery_final BEFORE UPDATE ON recovery_operations WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT,'injected recovery final failure'); END");
    await expect(f.service.reconcile(f.input(view))).rejects.toThrow("injected recovery final failure");
    expect(f.store.getTurn("original-turn")?.status).toBe("outcome_unknown");
    expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
    expect(f.store.getActiveTurn(f.session.id)?.id).toBe("original-turn");
    expect(f.store.getCommandReceipt("device", "original-command")?.state).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("device", "interrupt-command")?.state).toBe("outcome_unknown");
    expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("accepted");
    expect(f.recovery.operationForCommand("device", "recovery-command")?.phase).toBe("checking");
    expect(f.store.listEvents(f.session.id).events.some((event) => event.type === "turn.recovery.reconciled")).toBe(false);
  });

  it("issues resource-specific retained-release proof only after committed gate release and invalidates it on new execution", async () => {
    const f = fixture({ native: { state: "unknown", reason: "no_terminal" } });
    const view = await f.inspect();
    const proof = f.recovery.releaseProof(view.evidenceId, ["workspace:key"])!;
    const resource = { resourceKey: "workspace:key", ownerId: "original-owner", ownerGeneration: 2, purpose: "workspace:original-turn", retainedReason: "unknown execution" };
    expect(f.recovery.verifyReleaseProof(proof, resource)).toBe(false);
    await f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true });
    expect(f.recovery.verifyReleaseProof(proof, resource)).toBe(true);
    let uncommitted = true;
    f.store.db.transaction(() => { uncommitted = f.recovery.verifyReleaseProof(proof, resource); })();
    expect(uncommitted).toBe(false);
    expect(f.recovery.verifyReleaseProof({ ...proof, ownerGeneration: 3 }, resource)).toBe(false);
    expect(f.recovery.verifyReleaseProof({ ...proof, turnId: "wrong-turn" }, resource)).toBe(false);
    expect(f.recovery.verifyReleaseProof({ ...proof, resourceKeys: ["wrong-resource"] }, resource)).toBe(false);
    nextTurn(f);
    expect(f.recovery.verifyReleaseProof(proof, resource)).toBe(false);
  });
  it("keeps Host DB/identity ownership retained when another owned runtime is outside the stop proof", async () => {
    const f = fixture({ native: { state: "unknown", reason: "no_terminal" } });
    f.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,tree_control,state,updated_at)
      VALUES('process-other','original-owner',2,'other-runtime',1,'other-attempt','process_group','unknown','2026-10-15')`).run();
    const view = await f.inspect();
    await f.service.acknowledge({ ...f.input(view), acknowledgeUnknown: true });
    const workspaceProof = f.recovery.releaseProof(view.evidenceId, ["workspace:key"])!;
    const hostProof = f.recovery.releaseProof(view.evidenceId, ["db:key", "identity:key"])!;
    expect(f.recovery.verifyReleaseProof(workspaceProof, { resourceKey: "workspace:key", ownerId: "original-owner", ownerGeneration: 2, purpose: "workspace:original-turn" })).toBe(true);
    expect(f.recovery.verifyReleaseProof(hostProof, { resourceKey: "db:key", ownerId: "original-owner", ownerGeneration: 2, purpose: "host" })).toBe(false);
  });

});


describe("per-perform recovery authorization capture", () => {
  it("captures once per perform, snapshots the command, and never reuses a continuation across commands", async () => {
    const f = fixture(); const checked: string[] = []; const captured: string[] = [];
    const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(), inspectExecution: async () => stopped(), inspectNative: async () => terminal(),
      assertCommandAuthorized: (input) => { captured.push(input.commandId); return () => { checked.push(input.commandId); }; } });
    const inspect = () => service.inspect({ sessionId: f.session.id, turnId: f.context.flyxTurnId, attemptId: f.context.attemptId });
    const evidence = await inspect(); const request = f.input(evidence, "first-capture"); const pending = service.reconcile(request);
    request.commandId = "mutated-command"; request.authSubjectId = "mutated-actor";
    await expect(pending).resolves.toMatchObject({ state: "completed", gate: "released" });
    const fresh = await inspect(); await service.reconcile(f.input(fresh, "second-capture"));
    expect(captured).toEqual(["first-capture", "second-capture"]); expect(checked).toEqual(captured);
    expect(f.store.getCommandReceipt("device", "first-capture")?.state).toBe("completed");
    expect(f.store.getCommandReceipt("mutated-actor", "mutated-command")).toBeUndefined();
  });

  it("keeps legacy void authorization hooks fresh after asynchronous observation", async () => {
    const f = fixture(); const authorize = vi.fn(() => {});
    const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(), inspectExecution: async () => stopped(), inspectNative: async () => terminal(), assertCommandAuthorized: authorize });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: f.context.flyxTurnId, attemptId: f.context.attemptId });
    await service.reconcile(f.input(evidence)); expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("rejects an asynchronous captured continuation before terminal or gate settlement", async () => {
    const f = fixture(); const service = new RecoveryService({ store: f.store, now: () => new Date(clockStart).toISOString(), inspectExecution: async () => stopped(), inspectNative: async () => terminal(),
      assertCommandAuthorized: () => (() => Promise.resolve()) as () => void });
    const evidence = await service.inspect({ sessionId: f.session.id, turnId: f.context.flyxTurnId, attemptId: f.context.attemptId });
    await expect(service.reconcile(f.input(evidence))).rejects.toMatchObject({ code: "SYNCHRONOUS_RECOVERY_AUTHORIZATION_REQUIRED" });
    expect(f.store.getCommandReceipt("device", "recovery-command")?.state).toBe("failed");
    expect(f.store.getTurn(f.context.flyxTurnId)?.status).toBe("outcome_unknown"); expect(f.store.getSession(f.session.id)?.recoveryState).toBe("blocked");
  });

  it("rejects asynchronous authorization hooks before accepting any marker", async () => {
    const f = fixture(); const service = new RecoveryService({ store: f.store, assertCommandAuthorized: (() => Promise.resolve()) as () => void });
    const evidence = await f.inspect(); const sql = vi.spyOn(f.store.db, "prepare");
    await expect(service.reconcile(f.input(evidence))).rejects.toMatchObject({ code: "SYNCHRONOUS_RECOVERY_AUTHORIZATION_REQUIRED" });
    expect(sql).not.toHaveBeenCalled(); sql.mockRestore(); expect(f.store.getCommandReceipt("device", "recovery-command")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SessionNativeHandleSchema, type SessionNativeHandle } from "@flyx/mvp-protocol";
import { ClaudeAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import { HostManagedRuntime } from "../provider/native-runtime-factory.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { hasValidProcessStop, validateTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import { openOwned } from "../storage/open-store.js";
import { bindingDigest } from "./git-driver.js";
import { HostManagedNativeRevertPort, inspectManagedNativeRevertExecution, MANAGED_NATIVE_REVERT_BOUNDARY_VERSION } from "./managed-native-revert-port.js";
import { createNativeCheckpointAnchorCapture } from "./native-revert-anchors.js";
import {
  ClaudeNativeRevertDriver, CodexNativeRevertDriver, NATIVE_REVERT_DRIVER_VERSION,
  type ManagedNativeRevertPort, type NativeRevertHandle, type NativeRevertHistory,
  type NativeRevertJournalRecord, type NativeRevertMutation, type NativeRevertMutationJournal, type TrustedNativeRevertCapability,
} from "./native-revert-drivers.js";
import type { NativeRevertRequest } from "./revert-types.js";
import type { AdapterEvent } from "../provider/types.js";

/**
 * R6 L2 real-Provider full-revert acceptance. These tests run the REAL native
 * transports (Codex app-server thread/read + thread/revert; Claude Agent SDK
 * history read + forkSession) through the production managed boundary
 * (HostManagedRuntime + HostManagedNativeRevertPort + ProviderDriver), and
 * verify the three A9/A10 acceptance semantics:
 *   1. real full revert — prepare/apply produce an "applied" proof with the
 *      native history actually at the checkpoint boundary;
 *   2. response loss — a real mutation whose receipt is lost resolves to
 *      "unknown" and never re-sends (Codex additionally recovers to "applied"
 *      via an exact persisted boundary match);
 *   3. crash between claim and dispatch — "unknown", no re-send, history
 *      unchanged.
 * Gated: RUN_REAL_CODEX_REVERT=1 / RUN_REAL_CLAUDE_REVERT=1 (consumes quota).
 */

const codexRevertIt = process.env.RUN_REAL_CODEX_REVERT === "1" ? it : it.skip;
const claudeRevertIt = process.env.RUN_REAL_CLAUDE_REVERT === "1" ? it : it.skip;
const SESSION_ID = "spike-session";
const RUNTIME_ID = "spike-runtime";
const WORKSPACE_ID = "spike-workspace";
const PROVIDER_INSTANCE_ID = "spike-provider";
const CONFIGURATION_FINGERPRINT = "spike-fingerprint";
const VERIFIED_VERSION = "spike-native-v1";

type ManagedRow = { id: string; state: string; pid: number | null; process_group: number | null; identity_json: string | null; boundary_json: string | null; launch_digest: string | null; proof_json: string | null };

function rowProven(row: ManagedRow): boolean {
  if (row.state === "not_spawned" && row.pid === null) return true;
  if (row.state !== "stopped" || !row.identity_json || !row.proof_json || !row.launch_digest) return false;
  try {
    validateTreeStopEvidence(JSON.parse(row.proof_json), JSON.parse(row.identity_json),
      row.boundary_json ? { proof: JSON.parse(row.boundary_json), launchDigest: row.launch_digest } : undefined,
      row.process_group ?? undefined);
    return true;
  } catch { return false; }
}

/** In-memory journal with the production claim/record contract. `loseReceipt`
 * drops receipts to simulate a Host crash after the native side effect. */
function memoryJournal(loseReceipt = false): NativeRevertMutationJournal {
  const records = new Map<string, NativeRevertJournalRecord>();
  const key = (operationId: string, requestId: string) => `${operationId}:${requestId}`;
  return {
    claim: async (mutation) => {
      const record = records.get(key(mutation.operationId, mutation.requestId));
      if (record) {
        if (bindingDigest(record.mutation) !== bindingDigest(mutation)) throw new Error("NATIVE_REQUEST_REBOUND");
        return "existing";
      }
      records.set(key(mutation.operationId, mutation.requestId), { mutation: structuredClone(mutation) });
      return "claimed";
    },
    get: async (operationId, requestId) => {
      const record = records.get(key(operationId, requestId));
      return record ? structuredClone(record) : undefined;
    },
    record: async (mutation, receipt) => {
      const record = records.get(key(mutation.operationId, mutation.requestId));
      if (!record || bindingDigest(record.mutation) !== bindingDigest(mutation)) throw new Error("NATIVE_REQUEST_REBOUND");
      if (!loseReceipt) record.receipt = structuredClone(receipt);
    },
  };
}

async function spikeWorkspace(): Promise<string> { return mkdtemp(join(tmpdir(), "flyx-revert-spike-")); }

/** The src helper is a type-stripping-compatible single module (node >= 23.6
 * executes it directly); under vitest import.meta.url resolves into src/, where
 * the port's compiled dist/ default path does not exist. */
const CLAUDE_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "../provider/native-revert-helper.ts");

describe("R6 L2 real native revert (Codex)", () => {
  codexRevertIt("executes a real thread/revert full revert, recovers response loss and never re-sends", async () => {
    const workspace = await spikeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "flyx-revert-spike-data-"));
    const databasePath = join(dataDir, "host.sqlite"), identityDirectory = join(dataDir, "identity");
    await mkdir(identityDirectory, { recursive: true }); // the boundary realpaths every private root
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
    const store = openOwned({ databasePath, owner });
    const runtime = new HostManagedRuntime({ store, owner, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, workspace, provider: "codex" });
    const executable = process.env.FLYX_CODEX_EXECUTABLE ?? "codex";
    const sessionRows = (): ManagedRow[] => store.db.prepare(`SELECT p.id,p.state,p.pid,p.process_group,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json FROM managed_processes p
      LEFT JOIN managed_process_identities i ON i.process_id=p.id
      LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
      LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id
      WHERE p.session_id=? ORDER BY p.id`).all(SESSION_ID) as ManagedRow[];
    const nativeState = () => ({ quiescent: sessionRows().every(rowProven), pendingRequest: !sessionRows().every(rowProven) });
    const journal = memoryJournal();
    const port = new HostManagedNativeRevertPort({
      runtime: runtime.options, journal,
      contextFor: (handle, mutation) => ({
        hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, runtimeGeneration: 1,
        flyxTurnId: mutation ? mutation.operationId : "native-revert-read",
        attemptId: mutation ? mutation.requestId : `native-revert-read:${bindingDigest({ sessionId: SESSION_ID, nativeSessionId: handle.nativeSessionId })}`,
      }),
      assertCurrent: () => { owner.assertActive(); store.assertWriterOwner(); },
      nativeState: () => nativeState(),
      inspectExecution: (context) => inspectManagedNativeRevertExecution(store.db, context),
      codex: { executable },
    });
    const baseHandle = (nativeSessionId: string): NativeRevertHandle => ({
      provider: "codex", providerInstanceId: PROVIDER_INSTANCE_ID, nativeSessionId, workspaceId: WORKSPACE_ID, workspacePath: workspace,
      configurationFingerprint: CONFIGURATION_FINGERPRINT, verifiedVersion: VERIFIED_VERSION, sessionId: SESSION_ID,
    });
    const bindingFor = (nativeSessionId: string): SessionNativeHandle =>
      SessionNativeHandleSchema.parse({ v: 1, provider: "codex", providerInstanceId: PROVIDER_INSTANCE_ID, workspaceId: WORKSPACE_ID, nativeSessionId, provenance: "native" });
    const anchors = new Map<string, NativeRevertHandle>();
    const capture = createNativeCheckpointAnchorCapture({ port, metadataFor: (binding) => baseHandle(binding.nativeSessionId) });
    const anchorContext = { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, lease: { workspaceId: WORKSPACE_ID, leaseId: "spike-lease", generation: 1 }, sessionRevision: 1, epoch: "spike-epoch", runtimeGeneration: 1 };
    const capability = (handle: NativeRevertHandle): TrustedNativeRevertCapability => ({
      provider: "codex", providerInstanceId: handle.providerInstanceId, configurationFingerprint: handle.configurationFingerprint,
      verifiedVersion: handle.verifiedVersion, evidenceId: "spike-real-codex-evidence", driverVersion: NATIVE_REVERT_DRIVER_VERSION,
      managedBoundaryVersion: MANAGED_NATIVE_REVERT_BOUNDARY_VERSION, operations: ["conversation-rewind", "new-conversation"],
    });
    const runTurn = async (turnId: string, prompt: string, threadId?: string) => {
      const events: AdapterEvent[] = [];
      const adapter = new CodexAdapter({ ...runtime.options, workspace, onEvent: (event) => events.push(event), executable });
      await adapter.preflight();
      const context: DispatchContext = {
        hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID,
        flyxTurnId: turnId, runtimeId: RUNTIME_ID, runtimeGeneration: 1, attemptId: randomUUID(),
      };
      const outcome = await adapter.runTurn(turnId, prompt, threadId, context);
      const stop = await adapter.closeAndWait();
      // The port's canonical full-tree stop rule (managed-native-revert-port.ts `stopped`):
      // macOS settles as managed-group-stop evidence, which hasValidProcessStop accepts.
      expect(stop.stopped && stop.records.length > 0 && stop.records.every(hasValidProcessStop)).toBe(true);
      expect(outcome.status).toBe("completed");
      return outcome.providerSessionId;
    };
    try {
      // Three real turns; anchors captured at each proven-stopped boundary.
      const thread = await runTurn("spike-codex-turn-1", "Reply with exactly FLYX_REVERT_C1. Do not use tools and do not modify files.");
      anchors.set("a1", await capture({ ...anchorContext, nativeHandle: bindingFor(thread) }, "before") as NativeRevertHandle);
      await runTurn("spike-codex-turn-2", "Reply with exactly FLYX_REVERT_C2. Do not use tools and do not modify files.", thread);
      anchors.set("a12", await capture({ ...anchorContext, nativeHandle: bindingFor(thread) }, "before") as NativeRevertHandle);
      await runTurn("spike-codex-turn-3", "Reply with exactly FLYX_REVERT_C3. Do not use tools and do not modify files.", thread);

      const history = await port.read(baseHandle(thread));
      expect(history.entries.length).toBe(3);
      const originalHandle = bindingFor(thread);

      // 1. Real full revert: drop the third turn back to the a12 boundary.
      const driver = new CodexNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(thread) : anchors.get("a12")!, capability, port, journal });
      const preparation = await driver.prepare({ mode: "revert", originalHandle, targetHandle: originalHandle, checkpointId: "spike-checkpoint-a12", checkpointPhase: "before" });
      expect(preparation.supported).toBe(true);
      if (!preparation.supported) return;
      const request: NativeRevertRequest = { operationId: "spike-codex-op-1", requestId: "spike-codex-req-1", mode: "revert", originalHandle, preparation };
      const proof = await driver.apply(request);
      expect(proof.state).toBe("applied");
      const after = await port.read(baseHandle(thread));
      expect(after.entries.length).toBe(2);
      expect(after.entries.map((entry) => entry.id)).toEqual(anchors.get("a12")!.historyBoundary!.lastId ? [history.entries[0].id, anchors.get("a12")!.historyBoundary!.lastId] : after.entries.map((entry) => entry.id));

      // 2. Crash between claim and dispatch: unknown, no re-send, history unchanged.
      const journalCrash = memoryJournal();
      let executions = 0;
      const crashingPort: ManagedNativeRevertPort = {
        kind: port.kind, boundaryVersion: port.boundaryVersion, supportsTransition: (provider, mode) => port.supportsTransition(provider, mode),
        read: (handle) => port.read(handle), query: (mutation) => port.query(mutation),
        execute: () => { executions += 1; throw new Error("SPIKE_CRASH_AFTER_CLAIM"); },
      };
      const driverCrash = new CodexNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(thread) : anchors.get("a1")!, capability, port: crashingPort, journal: journalCrash });
      const preparationCrash = await driverCrash.prepare({ mode: "revert", originalHandle, targetHandle: originalHandle, checkpointId: "spike-checkpoint-a1", checkpointPhase: "before" });
      expect(preparationCrash.supported).toBe(true);
      if (!preparationCrash.supported) return;
      const requestCrash: NativeRevertRequest = { operationId: "spike-codex-op-2", requestId: "spike-codex-req-2", mode: "revert", originalHandle, preparation: preparationCrash };
      expect((await driverCrash.apply(requestCrash)).state).toBe("unknown");
      expect((await driverCrash.apply(requestCrash)).state).toBe("unknown");
      expect(executions).toBe(1); // the re-apply never dispatched again
      expect((await port.read(baseHandle(thread))).entries.length).toBe(2);

      // 3. Response loss: the real rollback happened, the receipt was lost.
      const journalLoss = memoryJournal(true);
      const portLoss = new HostManagedNativeRevertPort({ runtime: runtime.options, journal: journalLoss,
        contextFor: (handle, mutation) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, runtimeGeneration: 1, flyxTurnId: mutation ? mutation.operationId : "native-revert-read", attemptId: mutation ? mutation.requestId : `native-revert-read:${bindingDigest({ sessionId: SESSION_ID, nativeSessionId: handle.nativeSessionId })}` }),
        assertCurrent: () => { owner.assertActive(); store.assertWriterOwner(); }, nativeState: () => nativeState(),
        inspectExecution: (context) => inspectManagedNativeRevertExecution(store.db, context), codex: { executable } });
      const driverLoss = new CodexNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(thread) : anchors.get("a1")!, capability, port: portLoss, journal: journalLoss });
      const preparationLoss = await driverLoss.prepare({ mode: "revert", originalHandle, targetHandle: originalHandle, checkpointId: "spike-checkpoint-a1", checkpointPhase: "before" });
      expect(preparationLoss.supported).toBe(true);
      if (!preparationLoss.supported) return;
      const requestLoss: NativeRevertRequest = { operationId: "spike-codex-op-3", requestId: "spike-codex-req-3", mode: "revert", originalHandle, preparation: preparationLoss };
      // Codex recovers an applied-but-unacknowledged rollback from the exact persisted boundary.
      const lossProof = await driverLoss.apply(requestLoss);
      expect(lossProof.state).toBe("applied");
      expect((await port.read(baseHandle(thread))).entries.length).toBe(1);
      // A re-apply of the same lost request never rolls back a second time.
      expect((await driverLoss.apply(requestLoss)).state).toBe("applied");
      expect((await port.read(baseHandle(thread))).entries.length).toBe(1);
    } finally {
      await runtime.closeAndWait();
      store.close();
      owner.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe("R6 L2 real native revert (Claude)", () => {
  claudeRevertIt("executes a real forkSession full revert and returns unknown on response loss without re-forking", async () => {
    const workspace = await spikeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "flyx-revert-spike-data-"));
    const databasePath = join(dataDir, "host.sqlite"), identityDirectory = join(dataDir, "identity");
    await mkdir(identityDirectory, { recursive: true }); // the boundary realpaths every private root
    const owner = HostOwnerLock.acquire({ databasePath, identityDirectory });
    const store = openOwned({ databasePath, owner });
    const runtime = new HostManagedRuntime({ store, owner, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, workspace, provider: "claude" });
    const sessionRows = (): ManagedRow[] => store.db.prepare(`SELECT p.id,p.state,p.pid,p.process_group,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json FROM managed_processes p
      LEFT JOIN managed_process_identities i ON i.process_id=p.id
      LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
      LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id
      WHERE p.session_id=? ORDER BY p.id`).all(SESSION_ID) as ManagedRow[];
    const nativeState = () => ({ quiescent: sessionRows().every(rowProven), pendingRequest: !sessionRows().every(rowProven) });
    const journal = memoryJournal();
    const port = new HostManagedNativeRevertPort({
      runtime: runtime.options, journal,
      contextFor: (handle, mutation) => ({
        hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, runtimeGeneration: 1,
        flyxTurnId: mutation ? mutation.operationId : "native-revert-read",
        attemptId: mutation ? mutation.requestId : `native-revert-read:${bindingDigest({ sessionId: SESSION_ID, nativeSessionId: handle.nativeSessionId })}`,
      }),
      assertCurrent: () => { owner.assertActive(); store.assertWriterOwner(); },
      nativeState: () => nativeState(),
      inspectExecution: (context) => inspectManagedNativeRevertExecution(store.db, context),
      codex: { executable: "" }, claude: { helperPath: CLAUDE_HELPER_PATH },
    });
    const baseHandle = (nativeSessionId: string): NativeRevertHandle => ({
      provider: "claude", providerInstanceId: PROVIDER_INSTANCE_ID, nativeSessionId, workspaceId: WORKSPACE_ID, workspacePath: workspace,
      configurationFingerprint: CONFIGURATION_FINGERPRINT, verifiedVersion: VERIFIED_VERSION, sessionId: SESSION_ID,
    });
    const bindingFor = (nativeSessionId: string): SessionNativeHandle =>
      SessionNativeHandleSchema.parse({ v: 1, provider: "claude", providerInstanceId: PROVIDER_INSTANCE_ID, workspaceId: WORKSPACE_ID, nativeSessionId, provenance: "native" });
    const capture = createNativeCheckpointAnchorCapture({ port, metadataFor: (binding) => baseHandle(binding.nativeSessionId) });
    const anchorContext = { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, lease: { workspaceId: WORKSPACE_ID, leaseId: "spike-lease", generation: 1 }, sessionRevision: 1, epoch: "spike-epoch", runtimeGeneration: 1 };
    const capability = (handle: NativeRevertHandle): TrustedNativeRevertCapability => ({
      provider: "claude", providerInstanceId: handle.providerInstanceId, configurationFingerprint: handle.configurationFingerprint,
      verifiedVersion: handle.verifiedVersion, evidenceId: "spike-real-claude-evidence", driverVersion: NATIVE_REVERT_DRIVER_VERSION,
      managedBoundaryVersion: MANAGED_NATIVE_REVERT_BOUNDARY_VERSION, operations: ["conversation-rewind"],
    });
    const runTurn = async (turnId: string, prompt: string, resumeSessionId?: string) => {
      const events: AdapterEvent[] = [];
      const adapter = new ClaudeAdapter({ ...runtime.options, workspace, onEvent: (event) => events.push(event), maxBudgetUsd: 0.25 });
      const context: DispatchContext = {
        hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID,
        flyxTurnId: turnId, runtimeId: RUNTIME_ID, runtimeGeneration: 1, attemptId: randomUUID(),
      };
      const outcome = await adapter.runTurn(turnId, prompt, resumeSessionId, context);
      const stop = await adapter.closeAndWait();
      // The port's canonical full-tree stop rule (managed-native-revert-port.ts `stopped`):
      // macOS settles as managed-group-stop evidence, which hasValidProcessStop accepts.
      expect(stop.stopped && stop.records.length > 0 && stop.records.every(hasValidProcessStop)).toBe(true);
      expect(outcome.status).toBe("completed");
      return outcome.providerSessionId;
    };
    try {
      const session = await runTurn("spike-claude-turn-1", "Reply with exactly FLYX_REVERT_L1. Do not use any tools.");
      const anchor = await capture({ ...anchorContext, nativeHandle: bindingFor(session) }, "before") as NativeRevertHandle;
      await runTurn("spike-claude-turn-2", "Reply with exactly FLYX_REVERT_L2. Do not use any tools.", session);

      const originalHandle = bindingFor(session);
      const driver = new ClaudeNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(session) : anchor, capability, port, journal });
      const before: NativeRevertHistory = await port.read(baseHandle(session));
      expect(before.entries.length).toBeGreaterThan(anchor.historyBoundary!.entryCount);

      // 1. Real full revert: fork the conversation at the checkpoint boundary.
      const preparation = await driver.prepare({ mode: "revert", originalHandle, targetHandle: originalHandle, checkpointId: "spike-checkpoint-a1", checkpointPhase: "before" });
      expect(preparation.supported).toBe(true);
      if (!preparation.supported) return;
      const request: NativeRevertRequest = { operationId: "spike-claude-op-1", requestId: "spike-claude-req-1", mode: "revert", originalHandle, preparation };
      const proof = await driver.apply(request);
      expect(proof.state).toBe("applied");
      const forkBinding = SessionNativeHandleSchema.parse(proof.nativeHandle);
      expect(forkBinding.nativeSessionId).not.toBe(session);
      const forkHistory = await port.read(baseHandle(forkBinding.nativeSessionId));
      expect(forkHistory.entries.length).toBe(anchor.historyBoundary!.entryCount);
      // The original conversation must still exist and be unchanged.
      const originalAfter = await port.read(baseHandle(session));
      expect(originalAfter.entries.map((entry) => entry.digest)).toEqual(before.entries.map((entry) => entry.digest));

      // 2. Crash between claim and dispatch: unknown, no re-send, original unchanged.
      const journalCrash = memoryJournal();
      let executions = 0;
      const crashingPort: ManagedNativeRevertPort = {
        kind: port.kind, boundaryVersion: port.boundaryVersion, supportsTransition: (provider, mode) => port.supportsTransition(provider, mode),
        read: (handle) => port.read(handle), query: (mutation) => port.query(mutation),
        execute: () => { executions += 1; throw new Error("SPIKE_CRASH_AFTER_CLAIM"); },
      };
      const driverCrash = new ClaudeNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(session) : anchor, capability, port: crashingPort, journal: journalCrash });
      const requestCrash: NativeRevertRequest = { operationId: "spike-claude-op-2", requestId: "spike-claude-req-2", mode: "revert", originalHandle, preparation };
      expect((await driverCrash.apply(requestCrash)).state).toBe("unknown");
      expect((await driverCrash.apply(requestCrash)).state).toBe("unknown");
      expect(executions).toBe(1);
      expect((await port.read(baseHandle(session))).entries.map((entry) => entry.digest)).toEqual(before.entries.map((entry) => entry.digest));

      // 3. Response loss: the real fork happened but the receipt was lost —
      // Claude cannot uniquely identify the original fork, so it stays unknown
      // and never forks a second time.
      const journalLoss = memoryJournal(true);
      const portLoss = new HostManagedNativeRevertPort({ runtime: runtime.options, journal: journalLoss,
        contextFor: (handle, mutation) => ({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: SESSION_ID, runtimeId: RUNTIME_ID, runtimeGeneration: 1, flyxTurnId: mutation ? mutation.operationId : "native-revert-read", attemptId: mutation ? mutation.requestId : `native-revert-read:${bindingDigest({ sessionId: SESSION_ID, nativeSessionId: handle.nativeSessionId })}` }),
        assertCurrent: () => { owner.assertActive(); store.assertWriterOwner(); }, nativeState: () => nativeState(),
        inspectExecution: (context) => inspectManagedNativeRevertExecution(store.db, context), codex: { executable: "" }, claude: { helperPath: CLAUDE_HELPER_PATH } });
      const driverLoss = new ClaudeNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(session) : anchor, capability, port: portLoss, journal: journalLoss });
      const requestLoss: NativeRevertRequest = { operationId: "spike-claude-op-3", requestId: "spike-claude-req-3", mode: "revert", originalHandle, preparation };
      let lossExecutions = 0;
      const trackedLossPort: ManagedNativeRevertPort = {
        kind: portLoss.kind, boundaryVersion: portLoss.boundaryVersion, supportsTransition: (provider, mode) => portLoss.supportsTransition(provider, mode),
        read: (handle) => portLoss.read(handle), query: (mutation) => portLoss.query(mutation),
        execute: async (mutation) => { lossExecutions += 1; return portLoss.execute(mutation); },
      };
      const driverLossTracked = new ClaudeNativeRevertDriver({ resolveHandle: (binding, context) => context.role === "original" ? baseHandle(session) : anchor, capability, port: trackedLossPort, journal: journalLoss });
      const lossProof = await driverLossTracked.apply(requestLoss);
      expect(lossProof.state).toBe("unknown");
      expect((await driverLossTracked.apply(requestLoss)).state).toBe("unknown");
      expect(lossExecutions).toBe(1); // exactly one real fork; the retry never re-forked
      // The original conversation is still intact after the lost-receipt fork.
      expect((await port.read(baseHandle(session))).entries.map((entry) => entry.digest)).toEqual(before.entries.map((entry) => entry.digest));
    } finally {
      await runtime.closeAndWait();
      store.close();
      owner.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 600_000);
});

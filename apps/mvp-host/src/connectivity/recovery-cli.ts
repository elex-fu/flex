import { readFileSync, realpathSync } from "node:fs";
import type { RecoveryEvidence, RecoveryOperation } from "@flyx/mvp-protocol";
import { ExclusiveFileLock, HostOwnerLock, type RecoveryMaintenanceOwnerHandle } from "../lifecycle/host-owner.js";
import type { ProcessInspector } from "../lifecycle/process-inspector.js";
import { SystemProcessInspector } from "../lifecycle/process-inspector.js";
import { createHostRecovery, type HostRecoveryOptions } from "../session/host-recovery.js";
import type { SqliteStore } from "../storage/db.js";
import { RecoveryError } from "../storage/recovery-store.js";
import { openForRecoveryMaintenance, upgradeForRecoveryMaintenance } from "../storage/open-store.js";
import { applyRecoveryMigration } from "../storage/migrations/005-recovery.js";

export type RecoveryCliCommand = { kind: "recovery"; action: "inspect" | "reconcile" | "acknowledge"; sessionId: string; turnId: string;
  attemptId?: string; evidenceId?: string; expectedRecoveryRevision?: number; commandId?: string; acknowledgeUnknown?: true; upgradeMetadata: boolean };
const id = (value: string | undefined): value is string => !!value && /^[a-zA-Z0-9:_-]{1,256}$/.test(value);

export function parseRecoveryCommand(args: readonly string[]): RecoveryCliCommand | undefined {
  if (args[0] !== "recovery") return undefined;
  const action = args[1];
  if (!["inspect", "reconcile", "acknowledge"].includes(action ?? "") || !id(args[2]) || !id(args[3])) throw new Error("Invalid recovery target; supply the original Session and Turn IDs");
  const writing = action !== "inspect";
  let offset = writing ? 7 : 4;
  if (writing && (!id(args[4]) || !/^\d+$/.test(args[5] ?? "") || !Number.isSafeInteger(Number(args[5])) || !id(args[6]))) throw new Error("Recovery writes require evidenceId, recoveryRevision and commandId");
  let attemptId: string | undefined; let upgradeMetadata = false; let acknowledgeUnknown: true | undefined;
  while (offset < args.length) {
    const option = args[offset++];
    if (option === "--attempt" && !attemptId && id(args[offset])) attemptId = args[offset++];
    else if (option === "--upgrade-metadata" && !upgradeMetadata) upgradeMetadata = true;
    else if (option === "--acknowledge-unknown" && action === "acknowledge" && !acknowledgeUnknown) acknowledgeUnknown = true;
    else throw new Error("Unsupported or duplicate recovery option");
  }
  if (action === "acknowledge" && acknowledgeUnknown !== true) throw new Error("Explicit --acknowledge-unknown is required; the original result remains unknown");
  return { kind: "recovery", action: action as RecoveryCliCommand["action"], sessionId: args[2]!, turnId: args[3]!, upgradeMetadata,
    ...(attemptId ? { attemptId } : {}), ...(writing ? { evidenceId: args[4]!, expectedRecoveryRevision: Number(args[5]), commandId: args[6]! } : {}),
    ...(acknowledgeUnknown ? { acknowledgeUnknown } : {}) };
}

export type OfflineRecoveryOptions = {
  databasePath: string; identityDirectory?: string; coordinationDirectory?: string; inspector?: ProcessInspector;
  recoveryOptions?: Pick<HostRecoveryOptions, "resolveResource" | "inspectBoundary" | "codexReader">;
};
export type OfflineRecoveryResult = RecoveryEvidence | (RecoveryOperation & { ownershipReleased: boolean });

/** No normal Host, Provider factory, identity initialization, server or startup worker is constructed. */
export async function runOfflineRecovery(command: RecoveryCliCommand, options: OfflineRecoveryOptions): Promise<OfflineRecoveryResult> {
  const inspector = options.inspector ?? new SystemProcessInspector();
  const owner = HostOwnerLock.acquireForRecoveryMaintenance({ databasePath: options.databasePath,
    ...(options.identityDirectory ? { identityDirectory: options.identityDirectory } : {}),
    ...(options.coordinationDirectory ? { coordinationDirectory: options.coordinationDirectory } : {}), inspector });
  let store: SqliteStore | undefined; let workspaceLock: ExclusiveFileLock | undefined; let ownershipReleased = false;
  try {
    store = openForRecoveryMaintenance({ databasePath: owner.databasePath, owner });
    const version = (store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
    if (version < 5) {
      if (!command.upgradeMetadata) throw new RecoveryError("RECOVERY_SCHEMA_UPGRADE_REQUIRED");
      store.withRecoveryTransaction(() => upgradeForRecoveryMaintenance(owner, store!.db, applyRecoveryMigration));
    }
    const session = store.getSession(command.sessionId);
    if (!session) throw new RecoveryError("SESSION_NOT_FOUND");
    const workspace = realpathSync(session.workspacePath);
    try {
      workspaceLock = ExclusiveFileLock.acquireRetainedForMaintenance({ directory: owner.coordinationDirectory!, resourceKey: `workspace:${workspace}`, inspector, allowUnretainedCrash: true });
    } catch { /* Missing, foreign, unretained or concurrently guarded leases keep release unknown. */ }
    const recovery = createHostRecovery({ store, owner, sessionId: session.id, workspace, provider: session.provider,
      processInspector: inspector, ...options.recoveryOptions,
      inspectWorkspace: async (target) => heldOriginalWorkspace(owner, workspaceLock, target.turn.id) ? "clear" : "unknown" });
    const target = { sessionId: command.sessionId, turnId: command.turnId, ...(command.attemptId ? { attemptId: command.attemptId } : {}) };
    if (command.action === "inspect") return await recovery.inspect(target);
    const input = { ...target, authSubjectId: `local-recovery:${owner.ownerId}`, commandId: command.commandId!,
      evidenceId: command.evidenceId!, expectedRecoveryRevision: command.expectedRecoveryRevision! };
    const operation = command.action === "acknowledge" ? await recovery.acknowledge({ ...input, acknowledgeUnknown: true }) : await recovery.reconcile(input);
    if (operation.gate === "released" && workspaceLock) {
      const hostProof = recovery.recovery.releaseProof(input.evidenceId, owner.resourceKeys);
      const workspaceProof = recovery.recovery.releaseProof(input.evidenceId, [`workspace:${workspace}`]);
      if (hostProof && workspaceProof) {
        const verify = recovery.recovery.verifyReleaseProof;
        const verifyWorkspace: typeof verify = (proof, context) => context.purpose === `workspace:${command.turnId}` && verify(proof, context);
        // Check every held resource before changing any retained file.
        workspaceLock.validateRecovery(workspaceProof, verifyWorkspace);
        for (const resourceKey of owner.resourceKeys) if (!verify(hostProof, { resourceKey, ownerId: owner.ownerId, ownerGeneration: owner.generation, purpose: "host" })) throw new RecoveryError("RECOVERY_RELEASE_PROOF_INVALID");
        // A live Host runs the same reconciliation from its afterRecovery hook
        // (catalog-recovery): once the release is proven, the Session's
        // persisted runtime residency returns to "unloaded" so the next Host
        // start is writable instead of dead-ending in HOST_RECOVERY_REQUIRED
        // (CATALOG_RESIDENCY_UNRESOLVED). The offline CLI must mirror that, or
        // its successful release leaves the destination permanently gated.
        reconcileResidencyAfterRelease(store, command.sessionId, operation);
        workspaceLock.clearRetention(workspaceProof, verifyWorkspace);
        owner.clearRetention(hostProof, verify);
        workspaceLock.release(); workspaceLock = undefined;
        store.close(); store = undefined;
        owner.release(); ownershipReleased = true;
      }
    }
    return { ...operation, ownershipReleased };
  } finally {
    workspaceLock?.closeMaintenance();
    store?.close();
    if (!ownershipReleased) owner.closeMaintenance();
  }
}

/** Mirrors catalog-recovery's afterRecovery residency reconciliation for offline releases. */
function reconcileResidencyAfterRelease(store: SqliteStore, sessionId: string, operation: RecoveryOperation): void {
  // Legacy (pre-007) databases have no session_catalog residency column; nothing to reconcile.
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_catalog'").get()) return;
  store.withRecoveryTransaction(() => store.db.transaction(() => {
    const session = store.getSession(sessionId);
    // Same freshness contract as the live-host hook: a stale session state keeps the residency untouched.
    if (!session || session.activeTurnId || session.recoveryState !== "idle" || session.recoveryRevision !== operation.recoveryRevision) return;
    const row = store.db.prepare("SELECT residency_state FROM session_catalog WHERE session_id=?").get(sessionId) as { residency_state: string } | undefined;
    if (!row || row.residency_state === "unloaded") return;
    store.db.prepare("UPDATE session_catalog SET residency_state='unloaded' WHERE session_id=?").run(sessionId);
    store.commitEvent(sessionId, "session.recovery.residency.reconciled", { turnId: operation.turnId,
      operationId: operation.operationId, recoveryRevision: operation.recoveryRevision, residency: "unloaded" });
  })());
}

function heldOriginalWorkspace(owner: RecoveryMaintenanceOwnerHandle, lock: ExclusiveFileLock | undefined, turnId: string): boolean {
  if (!lock) return false;
  try {
    owner.assertActive(); lock.assertActive();
    const snapshot = JSON.parse(readFileSync(lock.path, "utf8")) as { ownerId?: string; ownerGeneration?: number; resourceKey?: string; purpose?: string };
    lock.assertActive();
    return snapshot.ownerId === owner.ownerId && snapshot.ownerGeneration === owner.generation && snapshot.purpose === `workspace:${turnId}`;
  } catch { return false; }
}

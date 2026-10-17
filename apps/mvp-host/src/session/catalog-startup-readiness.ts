import type Database from "better-sqlite3";
import type { RecoveryOperation } from "@flyx/mvp-protocol";
import type { HostCatalog } from "../catalog/host-catalog.js";
import { validateTreeStopEvidence, processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { isNativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import { dispatchContextForTurn, type DispatchContext } from "../provider/types.js";
import { RecoveryStore, digest, type RecoveryProcessRecord, type RecoveryTarget, type StoredRecoveryEvidence } from "../storage/recovery-store.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { catalogRecoveryConfigurationFingerprint } from "./catalog-recovery.js";

export type CatalogStartupReadiness = Readonly<{ ready: boolean; blockers: readonly string[] }>;
export type CatalogStartupReadinessOptions = { includeCurrentOwner?: boolean };
type CatalogFacts = Pick<HostCatalog, "store" | "catalog" | "owner">;
type Intent = { id: string; session_id: string; turn_id: string | null; attempt_id: string; runtime_generation: number;
  auth_subject_id: string; command_id: string; request_hash: string; kind: string; resource_id: string;
  state: string; dispatch_context_json: string | null; commit_id: string; source_sequence: number };
type Release = { evidenceId: string; context: DispatchContext; records: readonly string[]; acknowledged: boolean };

/** Fresh producer inventory, including inside an owned synchronous command transaction. No external work or mutation. */
export function inspectCatalogStartupReadiness(host: CatalogFacts, options: CatalogStartupReadinessOptions = {}): CatalogStartupReadiness {
  const blockers = new Set<string>();
  const block = (code: string) => { blockers.add(code); };
  try {
    const db = host.store.db;
    if (!db.open || inspectSchema(db).version !== SUPPORTED_SCHEMA_VERSION) return verdict(["STARTUP_SCHEMA_UNVERIFIED"]);
    const recovery = new RecoveryStore(host.store);
    const records = processRecords(db);
    const intents = db.prepare("SELECT * FROM execution_intents ORDER BY id").all() as Intent[];
    const turns = host.store.db.prepare("SELECT id FROM turns ORDER BY id").all() as Array<{ id: string }>;
    const targets = new Map<string, RecoveryTarget>();
    const releases = new Map<string, Release[]>();
    const context = (intent: Intent): DispatchContext | undefined => {
      try {
        if (!intent.dispatch_context_json) return undefined;
        const value = JSON.parse(intent.dispatch_context_json) as DispatchContext;
        const fence = dispatchContextForTurn(value.flyxTurnId, value);
        return fence.sessionId === intent.session_id && fence.attemptId === intent.attempt_id && fence.runtimeGeneration === intent.runtime_generation ? fence : undefined;
      } catch { return undefined; }
    };
    const current = (value: DispatchContext | undefined) => !options.includeCurrentOwner && value?.hostOwnerId === host.owner.ownerId && value.hostOwnerGeneration === host.owner.generation;
    const sourceBound = (intent: Intent) => {
      const source = db.prepare("SELECT commit_id FROM session_events WHERE session_id=? AND sequence=?").get(intent.session_id, intent.source_sequence) as { commit_id: string | null } | undefined;
      const receipt = host.store.getCommandReceipt(intent.auth_subject_id, intent.command_id);
      return source?.commit_id === intent.commit_id && receipt?.requestHash === intent.request_hash && receipt.targetSessionId === intent.session_id;
    };
    const currentCommand = (actor: string, command: string) => intents.some((intent) => intent.auth_subject_id === actor && intent.command_id === command
      && ["pending", "claimed", "dispatching", "acknowledged"].includes(intent.state) && current(context(intent)) && sourceBound(intent));
    for (const row of turns) {
      const turn = host.store.getTurn(row.id)!;
      const target = recovery.target(turn.sessionId, turn.id, turn.attemptId); targets.set(turn.id, target);
      const valid = releasedFacts(host, target, records); releases.set(turn.id, valid);
      if (["queued", "running", "waiting_approval", "interrupting"].includes(turn.status) && !current(target.context)) block("ORIGINAL_TURN_UNRESOLVED");
      if (turn.status === "outcome_unknown" && !valid.some((release) => release.acknowledged)) block("ORIGINAL_TURN_UNRESOLVED");
      if (!records.some((record) => record.sessionId === turn.sessionId && record.turnId === turn.id && record.attemptId === turn.attemptId)
        && !current(target.context)) block("ORIGINAL_LAUNCH_INVENTORY_MISSING");
    }
    for (const session of host.catalog.allSessions()) {
      const raw = host.store.getSession(session.sessionId)!;
      const active = raw.activeTurnId ? targets.get(raw.activeTurnId) : undefined;
      if (raw.recoveryState === "blocked" || raw.activityState === "outcome_unknown"
        || raw.activeTurnId && !current(active?.context)) block("ORIGINAL_SESSION_GATE_UNRESOLVED");
      if (session.residency === "blocked") block("CATALOG_RESIDENCY_UNRESOLVED");
    }
    for (const intent of intents) {
      if (intent.state === "settled") continue;
      const fence = context(intent);
      const released = intent.turn_id ? releases.get(intent.turn_id)?.some((release) => release.acknowledged
        && !!fence && digest(fence) === digest(release.context) && sourceBound(intent)) : false;
      if (intent.state === "outcome_unknown" ? !released : !current(fence) || !sourceBound(intent)) block("ORIGINAL_INTENT_UNRESOLVED");
    }
    const covered = new Set([...releases.values()].flatMap((items) => items.flatMap((release) => [...release.records])));
    for (const record of records) {
      const local = !options.includeCurrentOwner && record.ownerId === host.owner.ownerId && record.ownerGeneration === host.owner.generation;
      if (validNotSpawned(record) || journalStopped(record) || covered.has(record.id)) continue;
      if (local && record.state !== "unknown" && record.ownerId && record.runtimeId && record.attemptId
        && Number.isSafeInteger(record.runtimeGeneration) && record.runtimeGeneration > 0) continue;
      block("ORIGINAL_PROCESS_STOP_UNVERIFIED");
    }
    for (const close of db.prepare("SELECT * FROM catalog_runtime_operations WHERE state<>'completed'").all() as Array<{ state: string; owner_context_json: string }>) {
      const owner = JSON.parse(close.owner_context_json) as { ownerId?: string; ownerGeneration?: number };
      if (close.state === "outcome_unknown" || options.includeCurrentOwner || owner.ownerId !== host.owner.ownerId || owner.ownerGeneration !== host.owner.generation) block("CATALOG_RUNTIME_CLOSE_UNRESOLVED");
    }
    for (const capture of db.prepare("SELECT session_id,turn_id,attempt_id FROM checkpoint_captures WHERE status='capturing'").all() as Array<{ session_id: string; turn_id: string | null; attempt_id: string | null }>) {
      const original = capture.turn_id ? targets.get(capture.turn_id)?.context : undefined;
      if (!current(original) || original?.sessionId !== capture.session_id || original.attemptId !== capture.attempt_id) block("CHECKPOINT_CAPTURE_UNRESOLVED");
    }
    for (const operation of db.prepare("SELECT actor_id,command_id,status,stage FROM checkpoint_revert_operations WHERE status NOT IN ('completed','rolled_back')").all() as Array<{ actor_id: string; command_id: string; status: string; stage: string }>) {
      if (operation.status === "blocked" || operation.stage === "partial_failure" || !currentCommand(operation.actor_id, operation.command_id)) block("CHECKPOINT_REVERT_UNRESOLVED");
    }
    if (db.prepare("SELECT 1 FROM checkpoint_revert_gates WHERE state='blocked' LIMIT 1").get()) block("CHECKPOINT_REVERT_UNRESOLVED");
    for (const operation of db.prepare("SELECT actor_id,command_id,state FROM worktree_operations WHERE state IN ('pending','running','outcome_unknown')").all() as Array<{ actor_id: string; command_id: string; state: string }>) {
      if (operation.state === "outcome_unknown" || !currentCommand(operation.actor_id, operation.command_id)) block("WORKTREE_OPERATION_UNRESOLVED");
    }
    if (db.prepare("SELECT 1 FROM managed_worktrees WHERE state='blocked' LIMIT 1").get()) block("WORKTREE_OPERATION_UNRESOLVED");
    if (db.prepare("SELECT 1 FROM recovery_operations WHERE phase IN ('marked','checking') LIMIT 1").get()) block("RECOVERY_OPERATION_UNRESOLVED");
  } catch { block("STARTUP_FACTS_UNVERIFIED"); }
  return verdict([...blockers]);
}
function verdict(blockers: readonly string[]): CatalogStartupReadiness { return Object.freeze({ ready: !blockers.length, blockers: Object.freeze([...blockers].sort()) }); }

/** Historical proof remains tied to its original inventory; newer launches are checked separately. */
function releasedFacts(host: CatalogFacts, target: RecoveryTarget, records: readonly RecoveryProcessRecord[]): Release[] {
  if (!target.context || !target.turn.attemptId) return [];
  const db = host.store.db; const fence = target.context;
  const starts = db.prepare("SELECT * FROM execution_intents WHERE session_id=? AND turn_id=? AND attempt_id=? AND kind='start_turn'")
    .all(target.session.id, target.turn.id, target.turn.attemptId) as Intent[];
  const original = starts[0];
  try {
    if (starts.length !== 1 || !original?.dispatch_context_json || original.runtime_generation !== target.turn.generation
      || original.auth_subject_id !== target.turn.authSubjectId || original.command_id !== target.turn.commandId || original.request_hash !== target.turn.requestHash
      || digest(dispatchContextForTurn(target.turn.id, JSON.parse(original.dispatch_context_json) as DispatchContext)) !== digest(fence)) return [];
  } catch { return []; }
  const session = host.catalog.session(target.session.id); const workspace = session && host.catalog.workspace(session.workspaceId);
  const providerInstance = session && host.catalog.provider(session.providerInstanceId);
  if (!session || !workspace || !providerInstance || workspace.canonicalRoot !== target.session.workspacePath || providerInstance.provider !== target.session.provider) return [];
  if (target.nativeHandle && (target.nativeHandle.providerInstanceId !== providerInstance.providerInstanceId
    || target.nativeHandle.workspacePath !== workspace.canonicalRoot || target.nativeHandle.configurationFingerprint !== catalogRecoveryConfigurationFingerprint({ session, workspace, providerInstance }))) return [];
  const rows = db.prepare("SELECT * FROM recovery_operations WHERE turn_id=? AND attempt_id=? AND phase='completed'").all(target.turn.id, target.turn.attemptId) as Array<{
    id: string; session_id: string; action: string; evidence_id: string; auth_subject_id: string; command_id: string; request_hash: string; result_json: string | null; completed_revision: number | null }>;
  const valid: Release[] = [];
  for (const row of rows) {
    try {
      if (!row.result_json || row.session_id !== target.session.id || !row.completed_revision || row.completed_revision > target.session.revision) continue;
      const result = JSON.parse(row.result_json) as RecoveryOperation;
      const stored = db.prepare("SELECT * FROM recovery_evidence WHERE id=?").get(row.evidence_id) as { session_id: string; turn_id: string; attempt_id: string | null; recovery_revision: number; facts_fingerprint: string; evidence_json: string } | undefined;
      if (!stored) continue;
      const evidence = JSON.parse(stored.evidence_json) as StoredRecoveryEvidence; const stop = evidence.execution.evidence;
      if (result.operationId !== row.id || result.state !== "completed" || result.gate !== "released" || result.sessionId !== target.session.id
        || result.turnId !== target.turn.id || result.attemptId !== target.turn.attemptId || stored.session_id !== target.session.id || stored.turn_id !== target.turn.id
        || stored.attempt_id !== target.turn.attemptId || evidence.view.evidenceId !== row.evidence_id || evidence.view.sessionId !== target.session.id
        || evidence.view.turnId !== target.turn.id || evidence.view.attemptId !== target.turn.attemptId || stored.facts_fingerprint !== evidence.factsFingerprint
        || stored.recovery_revision !== evidence.view.recoveryRevision || result.recoveryRevision !== evidence.view.recoveryRevision + 1 || target.session.recoveryRevision < result.recoveryRevision
        || evidence.execution.state !== "stopped" || evidence.execution.workspaceState !== "clear" || evidence.view.processState !== "stopped" || evidence.view.workspaceState !== "clear"
        || !stop || stop.kind !== "process-tree-stopped" || stop.ownerId !== fence.hostOwnerId || stop.ownerGeneration !== fence.hostOwnerGeneration
        || !Array.isArray(stop.processRecordIds) || !stop.processRecordIds.length || !Array.isArray(stop.resourceKeys)
        || ![...host.owner.resourceKeys, `workspace:${workspace.worktreeRoot}`].every((key) => stop.resourceKeys.includes(key))) continue;
      const selected = records.filter((record) => stop.processRecordIds!.includes(record.id));
      if (selected.length !== new Set(stop.processRecordIds).size || selected.some((record) => record.ownerId !== stop.ownerId || record.ownerGeneration !== stop.ownerGeneration)
        || digest(selected) !== evidence.ownerJournalFingerprint || !selected.some((record) => record.sessionId === fence.sessionId && record.turnId === fence.flyxTurnId
          && record.attemptId === fence.attemptId && record.runtimeId === fence.runtimeId && record.runtimeGeneration === fence.runtimeGeneration)) continue;
      const proofs = selected.map((record) => validNotSpawned(record) ? { id: record.id, sourceId: digest(record), contractId: "spawn-not-created" } : boundaryStopped(record));
      if (proofs.some((proof) => !proof) || digest(proofs) !== stop.sourceId) continue;
      const receipt = host.store.getCommandReceipt(row.auth_subject_id, row.command_id);
      if (!receipt || receipt.state !== "completed" || receipt.method !== `session.recovery.${row.action}` || receipt.requestHash !== row.request_hash
        || receipt.targetSessionId !== target.session.id || digest(receipt.response) !== digest(result) || !receipt.commitId || !receipt.sourceSequence) continue;
      const source = db.prepare("SELECT type,payload_json,commit_id FROM session_events WHERE session_id=? AND sequence=?").get(target.session.id, receipt.sourceSequence) as { type: string; payload_json: string; commit_id: string | null } | undefined;
      const commit = db.prepare("SELECT session_id,last_sequence FROM event_commits WHERE id=?").get(receipt.commitId) as { session_id: string; last_sequence: number } | undefined;
      const acknowledged = row.action === "acknowledge";
      if (!source || source.commit_id !== receipt.commitId || commit?.session_id !== target.session.id || commit.last_sequence !== receipt.sourceSequence
        || source.type !== (acknowledged ? "turn.recovery.acknowledged" : "turn.recovery.reconciled")) continue;
      const payload = JSON.parse(source.payload_json) as Record<string, unknown>;
      if (payload.operationId !== row.id || payload.evidenceId !== row.evidence_id || payload.gate !== "released" || payload.recoveryRevision !== result.recoveryRevision
        || payload.turnId !== target.turn.id || payload.attemptId !== target.turn.attemptId) continue;
      if (acknowledged) {
        if (result.turnStatus !== "outcome_unknown" || evidence.native.state === "terminal" || payload.outcomePreserved !== "outcome_unknown") continue;
        // An original unknown attempt must have a frozen resource binding. An
        // ambiguous legacy/native-current inference cannot reopen admission.
        if (!target.nativeHandle) continue;
        const originalFacts = digest({ sessionId: target.session.id, activeTurnId: target.turn.id, recoveryState: "blocked",
          recoveryRevision: evidence.view.recoveryRevision, turnId: target.turn.id, attemptId: target.turn.attemptId, status: "outcome_unknown",
          nativeSessionId: target.turn.providerSessionId ?? null, nativeTurnId: target.turn.nativeTurnId ?? null, generation: target.turn.generation,
          context: fence, nativeHandle: target.nativeHandle, committedOutcome: null, processes: selected.filter((record) => record.runtimeId === fence.runtimeId) });
        if (originalFacts !== evidence.factsFingerprint) continue;
        if (target.turn.status === "outcome_unknown") {
          const original = target.turn.authSubjectId ? host.store.getCommandReceipt(target.turn.authSubjectId, target.turn.commandId) : undefined;
          const response = original?.response as { turnId?: string; acknowledged?: boolean; executionStopped?: boolean; evidenceId?: string } | undefined;
          if (!original || original.state !== "outcome_unknown" || original.method !== "session.startTurn" || original.requestHash !== target.turn.requestHash
            || original.targetSessionId !== target.session.id || original.commitId !== receipt.commitId || original.sourceSequence !== receipt.sourceSequence
            || response?.turnId !== target.turn.id || response.acknowledged !== true || response.executionStopped !== true || response.evidenceId !== row.evidence_id) continue;
        }
      }
      valid.push({ evidenceId: row.evidence_id, context: fence, records: selected.map((record) => record.id), acknowledged });
    } catch { /* An invalid historical marker never replaces stop evidence. */ }
  }
  return valid;
}
function validNotSpawned(record: RecoveryProcessRecord): boolean {
  return !!record.ownerId && !!record.runtimeId && !!record.attemptId && Number.isSafeInteger(record.ownerGeneration) && record.ownerGeneration > 0
    && Number.isSafeInteger(record.runtimeGeneration) && record.runtimeGeneration > 0 && record.state === "not_spawned" && record.pid === undefined && record.processGroup === undefined && !record.processIdentity && !record.boundary && !record.stopProof;
}
function boundaryStopped(record: RecoveryProcessRecord): { id: string; sourceId: string; contractId: string; identityDigest: string } | undefined {
  const identity = record.processIdentity; const boundary = record.boundary;
  if (!identity || identity.platform !== "linux" || !identity.birth || identity.birth.kind !== "linux" || identity.pid !== record.pid || !Number.isSafeInteger(identity.pid) || identity.pid < 1
    || !/^[a-f0-9-]{36}$/i.test(identity.birth.bootId) || !/^\d+$/.test(identity.birth.startTicks)
    || !boundary || !/^[a-f0-9]{64}$/.test(boundary.launchDigest) || !isNativeBoundaryProof(boundary.proof)
    || boundary.proof.platform !== "linux" || boundary.proof.treeIsolation !== "linux_pid_namespace" || !boundary.proof.verifiedDescendantStop) return undefined;
  const identityDigest = processIdentityDigest(identity);
  return { id: record.id, sourceId: boundary.proof.boundaryId + ":" + identityDigest,
    contractId: "native-boundary/v1/" + boundary.proof.backend + "/" + boundary.proof.evidenceDigest, identityDigest };
}
function journalStopped(record: RecoveryProcessRecord): boolean {
  if (record.state !== "stopped" || !record.stopProof) return false;
  const proof = boundaryStopped(record); if (!proof) return false;
  try { validateTreeStopEvidence(record.stopProof, record.processIdentity); }
  catch { return false; }
  return record.stopProof.sourceId === proof.sourceId && record.stopProof.contractId === proof.contractId;
}
function processRecords(db: Database.Database): RecoveryProcessRecord[] {
  type Row = { id: string; owner_id: string; owner_generation: number; runtime_id: string; runtime_generation: number; attempt_id: string;
    session_id: string | null; turn_id: string | null; pid: number | null; process_group: number | null; tree_control: RecoveryProcessRecord["treeControl"];
    state: RecoveryProcessRecord["state"]; updated_at: string; identity_json: string | null; boundary_json: string | null; launch_digest: string | null; stop_json: string | null };
  return (db.prepare(`SELECT p.*,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json AS stop_json FROM managed_processes p
    LEFT JOIN managed_process_identities i ON i.process_id=p.id LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
    LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id ORDER BY p.id`).all() as Row[]).map((row) => ({
    id: row.id, ownerId: row.owner_id, ownerGeneration: row.owner_generation, runtimeId: row.runtime_id, runtimeGeneration: row.runtime_generation,
    attemptId: row.attempt_id, ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.pid !== null ? { pid: row.pid } : {}), ...(row.process_group !== null ? { processGroup: row.process_group } : {}),
    ...(row.identity_json ? { processIdentity: JSON.parse(row.identity_json) as ProcessIdentity } : {}),
    ...(row.boundary_json && row.launch_digest ? { boundary: { proof: JSON.parse(row.boundary_json) as object, launchDigest: row.launch_digest } } : {}),
    ...(row.stop_json ? { stopProof: JSON.parse(row.stop_json) as NonNullable<RecoveryProcessRecord["stopProof"]> } : {}),
    treeControl: row.tree_control, state: row.state, updatedAt: row.updated_at }));
}

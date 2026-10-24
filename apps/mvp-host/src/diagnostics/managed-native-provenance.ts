import { nativeStopContractId, supportsNativeStop } from "../lifecycle/managed-stop-contract.js";
import type Database from "better-sqlite3";
import { validateTreeStopEvidence, type ProcessTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import { isNativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import { OperationsError } from "../operations/operation-files.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/recovery-fingerprint.js";
import type { ProviderConfiguration } from "../storage/catalog-store.js";
import type { DispatchContext, ProviderId } from "../provider/types.js";
import { assertCompleteCompatibilityArtifact, compatibilityEvidenceHash, type CompatibilityNativeProvenance, type NativeCompatibilityArtifact, type NativeCompatibilityEvidence } from "./compatibility-evidence.js";
import type { PlannedNativeArtifact } from "./planned-native-artifact.js";
import { compatibilityCanonicalJson, compatibilityDigest } from "./compatibility-integrity.js";

const key = (id: string) => "compatibility-launch/v1/" + id;
const refuse = (code: string): never => { throw new OperationsError(code); };
/** Provider-routed native approval methods (mirror of interaction methodMatches for kind "approval"). */
const APPROVAL_METHODS = new Set(["canUseTool/approval", "item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
/** Stable projection of a confirmed interaction row; the recorder and provenance derive the same anchor from it. */
export type CompatibilityInteractionAnchorRow = {
  interaction_id: string; session_id: string; turn_id: string; attempt_id: string | null;
  runtime_id: string | null; runtime_generation: number | null; native_request_id: string | null; native_method: string | null;
};
/** Deterministic digest anchor for one confirmed approval interaction (design §5). */
export function compatibilityInteractionAnchor(row: CompatibilityInteractionAnchorRow): string {
  return compatibilityDigest({ interactionId: row.interaction_id, sessionId: row.session_id, turnId: row.turn_id,
    attemptId: row.attempt_id, nativeRequestId: row.native_request_id, nativeMethod: row.native_method, status: "confirmed" });
}
/** Confirmed native-ack approvals for exactly this dispatch context; the recorder records one evidence row per entry. */
export function confirmedCompatibilityApprovalInteractions(db: Database.Database, context: DispatchContext): CompatibilityInteractionAnchorRow[] {
  return db.prepare(`SELECT interaction_id,session_id,turn_id,attempt_id,runtime_id,runtime_generation,native_request_id,native_method
    FROM interactions WHERE session_id=? AND turn_id=? AND attempt_id=? AND kind='approval' AND status='confirmed'
    AND native_request_id IS NOT NULL AND runtime_id=? AND runtime_generation=? ORDER BY created_at,interaction_id`)
    .all(context.sessionId, context.flyxTurnId, context.attemptId, context.runtimeId, context.runtimeGeneration) as CompatibilityInteractionAnchorRow[];
}
/**
 * Reconnect pin (design §5): the turn's start intent resumed the session's
 * pre-restart native session id, and the binding that established that native
 * session id ran under a different host owner generation (a host restart).
 */
export function resolveCompatibilityReconnectPin(db: Database.Database, context: DispatchContext, nativeSessionId: string): { resumeSessionId: string; establishedGeneration: number } | undefined {
  const intents = db.prepare(`SELECT payload_json FROM execution_intents WHERE session_id=? AND turn_id=? AND attempt_id=? AND kind='start_turn'`)
    .all(context.sessionId, context.flyxTurnId, context.attemptId) as Array<{ payload_json: string }>;
  const resumes = intents.map((row) => JSON.parse(row.payload_json) as { resumeSessionId?: unknown })
    .filter((payload) => typeof payload.resumeSessionId === "string" && payload.resumeSessionId === nativeSessionId);
  if (resumes.length !== 1) return undefined;
  const established = db.prepare(`SELECT turn_id,attempt_id,context_json FROM native_turn_bindings WHERE session_id=? AND native_session_id=? ORDER BY rowid`)
    .all(context.sessionId, nativeSessionId) as Array<{ turn_id: string; attempt_id: string; context_json: string }>;
  const original = established.find((row) => row.turn_id !== context.flyxTurnId || row.attempt_id !== context.attemptId);
  if (!original) return undefined;
  const originalContext = JSON.parse(original.context_json) as DispatchContext;
  if (typeof originalContext.hostOwnerId !== "string" || typeof originalContext.hostOwnerGeneration !== "number"
    || originalContext.sessionId !== context.sessionId || originalContext.hostOwnerGeneration === context.hostOwnerGeneration) return undefined;
  return { resumeSessionId: nativeSessionId, establishedGeneration: originalContext.hostOwnerGeneration };
}
/** Called by the actual spawn journal after durable launching/boundary commit and before OS spawn. */
export function saveCompatibilityLaunchArtifact(db: Database.Database, input: {
  processId: string; launchDigest: string; artifact: NativeCompatibilityArtifact; assertOwner: () => void;
}): void {
  input.assertOwner(); assertCompleteCompatibilityArtifact(input.artifact);
  db.transaction(() => {
    const launch = db.prepare(`SELECT p.state,p.pid,b.launch_digest FROM managed_processes p
      JOIN managed_process_boundaries b ON b.process_id=p.id WHERE p.id=?`).get(input.processId) as { state: string; pid: number | null; launch_digest: string } | undefined;
    if (!launch || launch.state !== "launching" || launch.pid !== null || launch.launch_digest !== input.launchDigest) refuse("COMPATIBILITY_LAUNCH_SNAPSHOT_LATE");
    const normalized = Object.fromEntries(Object.entries(input.artifact).filter(([, value]) => value !== undefined));
    const value = compatibilityCanonicalJson({ v: 1, processId: input.processId, launchDigest: input.launchDigest, artifact: normalized });
    const previous = db.prepare("SELECT value_json FROM host_state WHERE key=?").get(key(input.processId)) as { value_json: string } | undefined;
    if (previous && previous.value_json !== value) refuse("COMPATIBILITY_LAUNCH_SNAPSHOT_CONFLICT");
    if (!previous) db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES(?,?,?)").run(key(input.processId), value, new Date().toISOString());
  })();
}

/** Separate frozen planned bytes; never overwrites original OS launch/boundary evidence. */
export function savePlannedCompatibilityLaunch(db: Database.Database, processId: string, launchDigest: string, planned: PlannedNativeArtifact): void {
  db.transaction(() => {
    const launch = db.prepare(`SELECT p.state,p.pid,b.launch_digest FROM managed_processes p JOIN managed_process_boundaries b ON b.process_id=p.id WHERE p.id=?`).get(processId) as { state: string; pid: number | null; launch_digest: string } | undefined;
    const { snapshotDigest, ...payload } = planned;
    if (!launch || launch.state !== "launching" || launch.pid !== null || launch.launch_digest !== launchDigest || compatibilityDigest(payload) !== snapshotDigest) refuse("COMPATIBILITY_PLANNED_LAUNCH_INVALID");
    const entry = "compatibility-planned-launch/v1/" + processId;
    const encoded = compatibilityCanonicalJson({ v: 1, processId, launchDigest, planned });
    const previous = db.prepare("SELECT value_json FROM host_state WHERE key=?").get(entry) as { value_json: string } | undefined;
    if (previous && previous.value_json !== encoded) refuse("COMPATIBILITY_LAUNCH_SNAPSHOT_CONFLICT");
    if (!previous) db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES(?,?,?)").run(entry, encoded, new Date().toISOString());
  })();
}
/** Read-only binding of original launch, native result, and stop evidence; no process/model is started. */
export function resolveManagedNativeProvenance(db: Database.Database, context: DispatchContext,
  evidence: NativeCompatibilityEvidence, artifact: NativeCompatibilityArtifact): CompatibilityNativeProvenance {
  assertCompleteCompatibilityArtifact(artifact);
  // "recovery" records a verified read-only native-history inspection: its
  // nativeSourceId names the READ-path observation (Claude
  // resultUuid:resultDigest / Codex thread-read digest), never the original
  // terminal event, and its status match is proven by the recorder before
  // record(); provenance still pins the original event and binding below.
  if (!["turn", "interrupt", "stop", "recovery", "approval", "reconnect"].includes(evidence.kind) || !evidence.launchRef || !evidence.nativeSourceId
    || evidence.provider === "claude" && evidence.nativeResultId !== undefined && evidence.nativeResultId !== evidence.nativeSourceId
    || evidence.attemptId !== context.attemptId) refuse("COMPATIBILITY_NATIVE_SOURCE_UNSUPPORTED");
  return db.transaction(() => {
    const launch = db.prepare(`SELECT p.*,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json AS stop_json
      FROM managed_processes p JOIN managed_process_identities i ON i.process_id=p.id
      JOIN managed_process_boundaries b ON b.process_id=p.id LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id WHERE p.id=?`).get(evidence.launchRef!) as Record<string, unknown> | undefined;
    if (!launch) return refuse("COMPATIBILITY_LAUNCH_CONTEXT_MISMATCH");
    if (launch.owner_id !== context.hostOwnerId || launch.owner_generation !== context.hostOwnerGeneration
      || launch.runtime_id !== context.runtimeId || launch.runtime_generation !== context.runtimeGeneration || launch.attempt_id !== context.attemptId
      || launch.session_id !== context.sessionId || launch.turn_id !== context.flyxTurnId) refuse("COMPATIBILITY_LAUNCH_CONTEXT_MISMATCH");
    const saved = db.prepare("SELECT value_json FROM host_state WHERE key=?").get(key(evidence.launchRef!)) as { value_json: string } | undefined;
    const plannedRow = db.prepare("SELECT value_json FROM host_state WHERE key=?").get("compatibility-planned-launch/v1/" + evidence.launchRef) as { value_json: string } | undefined;
    if (!saved && !plannedRow) refuse("COMPATIBILITY_LAUNCH_ARTIFACT_UNAVAILABLE");
    const snapshot = saved ? JSON.parse(saved.value_json) as { v: number; processId: string; launchDigest: string; artifact: NativeCompatibilityArtifact } : undefined;
    if (snapshot && (snapshot.v !== 1 || snapshot.processId !== evidence.launchRef || snapshot.launchDigest !== launch.launch_digest
      || compatibilityDigest(snapshot.artifact) !== compatibilityDigest(Object.fromEntries(Object.entries(artifact).filter(([, value]) => value !== undefined))))) refuse("COMPATIBILITY_LAUNCH_ARTIFACT_MISMATCH");
    const plannedSnapshot = plannedRow ? JSON.parse(plannedRow.value_json) as { v: number; processId: string; launchDigest: string; planned: PlannedNativeArtifact } : undefined;
    if (plannedSnapshot) {
      const { snapshotDigest, ...measured } = plannedSnapshot.planned;
      if (plannedSnapshot.v !== 1 || plannedSnapshot.processId !== evidence.launchRef || plannedSnapshot.launchDigest !== launch.launch_digest
        || compatibilityDigest(measured) !== snapshotDigest || ![measured.executable, ...measured.scripts].some((file) => file.path === artifact.executablePath && file.digest === artifact.executableDigest)
        || measured.nodeVersion !== artifact.nodeVersion || measured.os !== artifact.os || measured.hostBuildDigest !== artifact.runtimeDigest) refuse("COMPATIBILITY_LAUNCH_ARTIFACT_MISMATCH");
    }
    const binding = db.prepare("SELECT * FROM native_turn_bindings WHERE turn_id=? AND attempt_id=?").get(context.flyxTurnId, context.attemptId) as Record<string, unknown> | undefined;
    // The binding's configuration fingerprint is written by host-recovery in the
    // recovery domain (catalogRecoveryConfigurationFingerprint over the live
    // session/workspace/provider rows), while the artifact's configFingerprint
    // is the compatibility domain (providerConfigurationFingerprint over the
    // provider activation configuration). The two never compare equal; instead
    // re-derive both from the persisted catalog rows inside this transaction
    // and prove each side independently: the binding belongs to exactly this
    // live resource, and the artifact attests exactly this resource's provider
    // configuration. verified_version stays "unknown" until a verified
    // recovery manifest is wired (R4); the provider version itself is already
    // proven by the version-probe fact and the planned-launch executable
    // digest, so only a known-but-conflicting version is refused here.
    const resource = db.prepare(`SELECT s.workspace_id AS workspace_id, w.canonical_root, w.worktree_root, w.checkout_key, w.kind, w.repository_id,
      p.id AS provider_instance_id, p.provider AS provider, p.executable, p.config_json, p.policy_version, p.policy_capabilities_json
      FROM sessions s JOIN session_catalog c ON c.session_id=s.id JOIN workspaces w ON w.id=s.workspace_id
      JOIN provider_instances p ON p.id=c.provider_instance_id WHERE s.id=?`).get(context.sessionId) as {
      workspace_id: string; canonical_root: string; worktree_root: string; checkout_key: string; kind: string; repository_id: string;
      provider_instance_id: string; provider: string; executable: string; config_json: string; policy_version: number; policy_capabilities_json: string;
    } | undefined;
    const providerConfig = resource ? JSON.parse(resource.config_json) as ProviderConfiguration : undefined;
    if (!binding || !resource || !providerConfig || binding.provider !== evidence.provider || binding.session_id !== context.sessionId || binding.native_session_id !== evidence.nativeSessionId
      || (binding.native_turn_id ?? undefined) !== evidence.nativeTurnId
      || compatibilityCanonicalJson(JSON.parse(String(binding.context_json))) !== compatibilityCanonicalJson(context)
      || binding.provider_instance_id !== resource.provider_instance_id
      || binding.configuration_fingerprint !== catalogRecoveryConfigurationFingerprint({ session: { workspaceId: resource.workspace_id },
        providerInstance: { providerInstanceId: resource.provider_instance_id, provider: resource.provider as ProviderId, executable: resource.executable,
          config: providerConfig, policyVersion: resource.policy_version, policyCapabilities: JSON.parse(resource.policy_capabilities_json) as string[] },
        workspace: { canonicalRoot: resource.canonical_root, worktreeRoot: resource.worktree_root, checkoutKey: resource.checkout_key,
          repositoryId: resource.repository_id, kind: resource.kind as "local" | "worktree" } })
      || artifact.configFingerprint !== providerConfigurationFingerprint({ config: providerConfig, policyVersion: resource.policy_version })
      || (binding.verified_version !== "unknown" && /\b(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\b/.exec(String(binding.verified_version))?.[1] !== artifact.providerVersion)) refuse("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    const rows = db.prepare(`SELECT id,sequence,type,payload_json FROM session_events WHERE session_id=?
      AND type IN ('turn.completed','turn.failed','turn.cancelled') AND json_extract(payload_json,'$.dispatchContext.flyxTurnId')=?
      AND json_extract(payload_json,'$.dispatchContext.attemptId')=?`).all(context.sessionId, context.flyxTurnId, context.attemptId) as Array<{ id: string; sequence: number; type: string; payload_json: string }>;
    const native = rows.filter((row) => {
      const payload = JSON.parse(row.payload_json) as { terminalEvidence?: { kind?: string; sourceId?: string }; dispatchContext?: unknown };
      if (payload.terminalEvidence?.kind !== "native-terminal" || compatibilityCanonicalJson(payload.dispatchContext) !== compatibilityCanonicalJson(context)) return false;
      if (evidence.kind === "recovery") {
        // The recovery read records the verified status/native-session match
        // itself before record(); here the original terminal event is pinned
        // by identity (turn + attempt + native-terminal dispatch context) and
        // by its digest below, not by the read-path sourceId.
        return true;
      }
      if (evidence.kind === "approval") {
        // An approval is not a terminal: the original terminal event is pinned
        // by identity and digest, while the interaction row below carries the
        // request anchor (nativeSourceId) and the native-ack delivery proof.
        return true;
      }
      return payload.terminalEvidence.sourceId === evidence.nativeSourceId
        && (evidence.result !== "passed" || row.type === (evidence.kind === "turn" || evidence.kind === "reconnect" ? "turn.completed" : "turn.cancelled"));
    });
    if (native.length !== 1) refuse("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
    let interaction: { row: CompatibilityInteractionAnchorRow; delivery: Array<{ kind: string; source_id: string | null }> } | undefined;
    let reconnect: { resumeSessionId: string; establishedGeneration: number } | undefined;
    if (evidence.kind === "approval") {
      // Exactly one confirmed interaction row for this attempt/native request;
      // native-ack delivery with a source id proves the answer reached the
      // provider, and the method's provider routing must be consistent.
      const rows = db.prepare(`SELECT interaction_id,session_id,turn_id,attempt_id,runtime_id,runtime_generation,native_request_id,native_method
        FROM interactions WHERE session_id=? AND turn_id=? AND attempt_id=? AND kind='approval' AND status='confirmed' AND native_request_id=?`)
        .all(context.sessionId, context.flyxTurnId, context.attemptId, evidence.nativeRequestId) as CompatibilityInteractionAnchorRow[];
      if (rows.length !== 1) return refuse("COMPATIBILITY_INTERACTION_ANCHOR_MISSING");
      const row = rows[0]!;
      if (row.runtime_id !== context.runtimeId || row.runtime_generation !== context.runtimeGeneration || !row.native_method
        || !APPROVAL_METHODS.has(row.native_method) || (evidence.provider === "codex") !== row.native_method.startsWith("item/")
        || compatibilityInteractionAnchor(row) !== evidence.nativeSourceId) refuse("COMPATIBILITY_INTERACTION_ANCHOR_MISMATCH");
      const delivery = db.prepare(`SELECT kind,source_id FROM interaction_delivery_evidence WHERE interaction_id=? ORDER BY created_at,id`)
        .all(row.interaction_id) as Array<{ kind: string; source_id: string | null }>;
      if (!delivery.some((record) => record.kind === "native-ack" && record.source_id)) refuse("COMPATIBILITY_INTERACTION_DELIVERY_UNVERIFIED");
      interaction = { row, delivery };
    }
    if (evidence.kind === "reconnect") {
      // The binding guard above already refused an absent row; the assertion
      // only satisfies narrowing the guard's never-returning helper loses.
      reconnect = resolveCompatibilityReconnectPin(db, context, String(binding!.native_session_id));
      if (!reconnect) return refuse("COMPATIBILITY_RECONNECT_PIN_MISSING");
    }
    const identity = JSON.parse(String(launch.identity_json)) as ProcessIdentity;
    const boundary = JSON.parse(String(launch.boundary_json)) as unknown;
    const stop = launch.stop_json ? JSON.parse(String(launch.stop_json)) as ProcessTreeStopEvidence : undefined;
    if (!isNativeBoundaryProof(boundary) || !supportsNativeStop(boundary) || !stop || launch.state !== "stopped"
      || artifact.supervisionContractId !== stop.contractId || stop.contractId !== nativeStopContractId(boundary)
      || evidence.stopRef && evidence.stopRef !== evidence.launchRef) refuse("COMPATIBILITY_STOP_PROOF_MISSING");
    validateTreeStopEvidence(stop!, identity, { proof: boundary as object, launchDigest: String(launch.launch_digest) }, Number(launch.process_group));
    return { provider: evidence.provider, attemptIdHash: compatibilityEvidenceHash(context.attemptId),
      launchRecordDigest: compatibilityDigest({ processId: evidence.launchRef, owner: [context.hostOwnerId, context.hostOwnerGeneration], runtime: [context.runtimeId, context.runtimeGeneration],
        attemptId: context.attemptId, sessionId: context.sessionId, turnId: context.flyxTurnId, identity, boundary, launchDigest: launch.launch_digest, snapshot: snapshot ?? null, plannedSnapshot: plannedSnapshot ?? null }),
      nativeObservationDigest: interaction
        ? compatibilityDigest({ interaction: interaction.row, delivery: interaction.delivery, terminal: native[0], binding })
        : reconnect
          ? compatibilityDigest({ event: native[0], binding, reconnect })
          : compatibilityDigest({ event: native[0], binding }), stopRecordDigest: compatibilityDigest({ processId: evidence.launchRef, stop }),
      executableDigest: artifact.executableDigest!, runtimeDigest: artifact.runtimeDigest!, configFingerprint: artifact.configFingerprint!, supervisionContractId: artifact.supervisionContractId! };
  })();
}

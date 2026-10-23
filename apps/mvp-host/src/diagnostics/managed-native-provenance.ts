import { nativeStopContractId, supportsNativeStop } from "../lifecycle/managed-stop-contract.js";
import type Database from "better-sqlite3";
import { validateTreeStopEvidence, type ProcessTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import { isNativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import { OperationsError } from "../operations/operation-files.js";
import type { DispatchContext } from "../provider/types.js";
import { assertCompleteCompatibilityArtifact, compatibilityEvidenceHash, type CompatibilityNativeProvenance, type NativeCompatibilityArtifact, type NativeCompatibilityEvidence } from "./compatibility-evidence.js";
import type { PlannedNativeArtifact } from "./planned-native-artifact.js";
import { compatibilityCanonicalJson, compatibilityDigest } from "./compatibility-integrity.js";

const key = (id: string) => "compatibility-launch/v1/" + id;
const refuse = (code: string): never => { throw new OperationsError(code); };
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
  if (!["turn", "interrupt", "stop"].includes(evidence.kind) || !evidence.launchRef || !evidence.nativeSourceId || evidence.provider === "claude" && evidence.nativeResultId !== undefined && evidence.nativeResultId !== evidence.nativeSourceId || evidence.attemptId !== context.attemptId) refuse("COMPATIBILITY_NATIVE_SOURCE_UNSUPPORTED");
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
    if (!binding || binding.provider !== evidence.provider || binding.session_id !== context.sessionId || binding.native_session_id !== evidence.nativeSessionId
      || (binding.native_turn_id ?? undefined) !== evidence.nativeTurnId || binding.configuration_fingerprint !== artifact.configFingerprint || (/\b(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\b/.exec(String(binding.verified_version))?.[1] ?? binding.verified_version) !== artifact.providerVersion
      || compatibilityCanonicalJson(JSON.parse(String(binding.context_json))) !== compatibilityCanonicalJson(context)) refuse("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    const rows = db.prepare(`SELECT id,sequence,type,payload_json FROM session_events WHERE session_id=?
      AND type IN ('turn.completed','turn.failed','turn.cancelled') AND json_extract(payload_json,'$.dispatchContext.flyxTurnId')=?
      AND json_extract(payload_json,'$.dispatchContext.attemptId')=?`).all(context.sessionId, context.flyxTurnId, context.attemptId) as Array<{ id: string; sequence: number; type: string; payload_json: string }>;
    const native = rows.filter((row) => {
      const payload = JSON.parse(row.payload_json) as { terminalEvidence?: { kind?: string; sourceId?: string }; dispatchContext?: unknown };
      return payload.terminalEvidence?.kind === "native-terminal" && payload.terminalEvidence.sourceId === evidence.nativeSourceId
        && compatibilityCanonicalJson(payload.dispatchContext) === compatibilityCanonicalJson(context)
        && (evidence.result !== "passed" || row.type === (evidence.kind === "turn" ? "turn.completed" : "turn.cancelled"));
    });
    if (native.length !== 1) refuse("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
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
      nativeObservationDigest: compatibilityDigest({ event: native[0], binding }), stopRecordDigest: compatibilityDigest({ processId: evidence.launchRef, stop }),
      executableDigest: artifact.executableDigest!, runtimeDigest: artifact.runtimeDigest!, configFingerprint: artifact.configFingerprint!, supervisionContractId: artifact.supervisionContractId! };
  })();
}

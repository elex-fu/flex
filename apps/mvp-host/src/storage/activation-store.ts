import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CatalogError, type ProviderVerification, type ProviderInstanceRecord, type WorkspaceRecord } from "./catalog-store.js";

/**
 * Local management-operation receipt and resource readiness store for the
 * explicit verify/activate flow (design §6.3, migration 011).
 *
 * One operation row is one durable local management receipt. `verify` claims
 * and settles a receipt holding the activation evidence; `activate` writes its
 * own receipt and, in the same short transaction, CASes the resource
 * `readiness_revision` values and either records the activation reference and
 * binding digest or persists the concrete blocking reasons. No Provider, Git or
 * helper process is ever created here.
 */

export type ActivationOperationKind = "activation" | "restore_check";
export type ActivationOperationState = "accepted" | "checking" | "ready" | "completed" | "rejected" | "outcome_unknown";
export type ActivationResourceKind = "workspace" | "provider";

/** Stable decision vocabulary shared with the service, the startup gate and the RPC projection. */
export type ActivationReasonCode =
  | "ACTIVATION_OWNER_INVALID"
  | "ACTIVATION_SOURCE_BINDING_CHANGED"
  | "ACTIVATION_EVIDENCE_INVALID"
  | "ACTIVATION_OPERATION_NOT_FOUND"
  | "ACTIVATION_OBSERVATION_UNAVAILABLE"
  | "ACTIVATION_RESOURCE_CHANGED"
  | "ACTIVATION_RESOURCES_UNVERIFIED"
  | "ACTIVATION_SCHEMA_UNAVAILABLE"
  | "ACTIVATION_EVIDENCE_EXPIRED"
  | "ACTIVATION_VERIFICATION_MISSING"
  | "ACTIVATION_INSPECT_UNVERIFIED"
  | "ORIGINAL_PRODUCERS_UNRESOLVED"
  | "RESTORE_GATE_UNRESOLVED"
  | "SUPERVISION_CONTRACT_UNAVAILABLE"
  | "WORKSPACE_CHECKOUT_UNAVAILABLE"
  | "WORKSPACE_IDENTITY_CHANGED"
  | "WORKSPACE_NOT_ACTIVATED"
  | "WORKSPACE_NOT_VERIFIED"
  | "WORKSPACE_POLICY_CHANGED"
  | "WORKSPACE_PRIVATE_DIRECTORY_OVERLAP"
  | "WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE"
  | "WORKSPACE_QUERY_UNVERIFIED"
  | "PROVIDER_COMPATIBILITY_EVIDENCE_INVALID"
  | "PROVIDER_COMPATIBILITY_EVIDENCE_MISSING"
  | "PROVIDER_CONFIG_CHANGED"
  | "PROVIDER_EVIDENCE_CHANGED"
  | "PROVIDER_EXECUTABLE_UNAVAILABLE"
  | "PROVIDER_EXECUTABLE_CHANGED"
  | "PROVIDER_NOT_ACTIVATED"
  | "PROVIDER_NOT_VERIFIED"
  | "PROVIDER_POLICY_CHANGED"
  | "PROVIDER_RUNTIME_CHANGED"
  | "PROVIDER_RUNTIME_UNAVAILABLE";

export type ActivationResourceBinding = Readonly<{ workspaceId: string; providerInstanceId: string }>;
export type ActivationResourceTarget = Readonly<{ kind: ActivationResourceKind; id: string; revision: number }>;

export type ActivationResourceState = "missing" | "valid" | "invalid" | "stale" | "uncheckable";

/** One read-only resource verdict. Reasons are sorted, de-duplicated and stable. */
export type ActivationResourceReadiness = Readonly<{
  state: ActivationResourceState;
  ready: boolean;
  resourceKind: ActivationResourceKind;
  resourceId: string;
  readinessRevision: number;
  reasonCodes: readonly ActivationReasonCode[];
  /** Present only while the recorded activation is currently valid. */
  evidenceId?: string;
  validUntil?: string;
}>;

export type ActivationOperation = Readonly<{
  id: string;
  actorId: string;
  commandId: string;
  kind: ActivationOperationKind;
  requestHash: string;
  state: ActivationOperationState;
  revision: number;
  ownerContext: Readonly<{ ownerId: string; ownerGeneration: number; resourceKeys: readonly string[] }>;
  resourceBinding: ActivationResourceBinding;
  evidence?: Readonly<{ id: string; digest: string; validUntil?: string; payload?: Readonly<object> }>;
  result?: Readonly<{ reasonCodes: readonly ActivationReasonCode[]; activations: readonly ActivationResourceTarget[] }>;
  createdAt: string;
  updatedAt: string;
}>;

export type ActivationEvidenceRecord = Readonly<{
  id: string;
  kind: ActivationOperationKind;
  requestHash: string;
  digest: string;
  validUntil: string;
  workspaceId: string;
  providerInstanceId: string;
  operationId: string;
  payload: Readonly<object>;
}>;

export type ActivationWriteOutcome =
  | Readonly<{ kind: "ready"; operation: ActivationOperation }>
  | Readonly<{ kind: "invalidated"; operation: ActivationOperation; reasonCodes: readonly ActivationReasonCode[] }>;

export type ActivationOperationStoreOptions = {
  /** One writer owner check from Main; no RPC payload can supply an owner. */
  guard: () => void;
};

/** Catalog facts the operation store needs; the runtime HostCatalog is never constructed for this. */
export type ActivationStoreResource = {
  db: Database.Database;
  workspace(id: string): WorkspaceRecord | undefined;
  provider(id: string): ProviderInstanceRecord | undefined;
};

type RawOperation = {
  id: string; actor_id: string; command_id: string; kind: ActivationOperationKind; request_hash: string;
  state: ActivationOperationState; revision: number; owner_context_json: string; resource_binding_json: string;
  evidence_json: string | null; result_json: string | null; created_at: string; updated_at: string;
};

export class ActivationError extends Error {
  constructor(readonly code: string, message = code, readonly retryable = false) { super(message); this.name = "ActivationError"; }
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function nowIso(): string { return new Date().toISOString(); }
function tableFor(kind: ActivationResourceKind): "workspaces" | "provider_instances" { return kind === "workspace" ? "workspaces" : "provider_instances"; }
function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ActivationError("ACTIVATION_RESOURCE_CHANGED", `Invalid ${label} revision`);
}
function assertOperationId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
}
function sortedReasons(values: readonly ActivationReasonCode[]): readonly ActivationReasonCode[] {
  return Object.freeze([...new Set(values)].sort()) as readonly ActivationReasonCode[];
}

export class ActivationOperationStore {
  constructor(readonly resources: ActivationStoreResource, private readonly options: ActivationOperationStoreOptions) {}

  /** Fail-closed availability: an older Store without migration 011 can never activate. */
  get available(): boolean {
    try {
      const db = this.resources.db;
      if (!db.open) return false;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_execution_operations'").get()) return false;
      for (const table of ["workspaces", "provider_instances"] as const) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        for (const name of ["activation_operation_id", "activation_binding_digest", "readiness_revision"]) {
          if (!columns.some((column) => column.name === name)) return false;
        }
      }
      return true;
    } catch { return false; }
  }

  operation(id: string): ActivationOperation | undefined {
    const row = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE id=?").get(id) as RawOperation | undefined;
    return row ? this.materialize(row) : undefined;
  }

  requireOperation(id: string): ActivationOperation {
    const operation = this.operation(id);
    if (!operation) throw new ActivationError("ACTIVATION_OPERATION_NOT_FOUND");
    return operation;
  }

  operationForCommand(actorId: string, commandId: string): ActivationOperation | undefined {
    const row = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE actor_id=? AND command_id=?").get(actorId, commandId) as RawOperation | undefined;
    return row ? this.materialize(row) : undefined;
  }

  /** Latest mgmt operation for a resource binding + kind, newest first. */
  latestForResource(kind: ActivationOperationKind, binding: ActivationResourceBinding): ActivationOperation | undefined {
    const rows = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE kind=? ORDER BY created_at DESC,id DESC").all(kind) as RawOperation[];
    for (const row of rows) {
      const operation = this.materialize(row);
      if (operation.resourceBinding.workspaceId === binding.workspaceId && operation.resourceBinding.providerInstanceId === binding.providerInstanceId) return operation;
    }
    return undefined;
  }

  /** The operation row a resource currently references, if reachable. */
  referencedOperation(kind: ActivationResourceKind, id: string): ActivationOperation | undefined {
    const row = this.resources.db.prepare(`SELECT activation_operation_id FROM ${tableFor(kind)} WHERE id=?`).get(id) as { activation_operation_id: string | null } | undefined;
    return row?.activation_operation_id ? this.operation(row.activation_operation_id) : undefined;
  }

  /** Rows misreferencing a missing or unfinished receipt cannot gate admission. */
  isReadinessReachable(kind: ActivationResourceKind, id: string): boolean {
    return this.referencedOperation(kind, id)?.state === "completed";
  }

  recordReadiness(kind: ActivationResourceKind, id: string): number {
    const row = this.resources.db.prepare(`SELECT readiness_revision FROM ${tableFor(kind)} WHERE id=?`).get(id) as { readiness_revision: number } | undefined;
    if (!row) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
    assertRevision(row.readiness_revision, "readiness");
    return row.readiness_revision;
  }

  recordDigests(kind: ActivationResourceKind, id: string): Readonly<{ activationOperationId?: string; bindingDigest?: string; readinessRevision: number }> {
    const row = this.resources.db.prepare(`SELECT activation_operation_id,activation_binding_digest,readiness_revision FROM ${tableFor(kind)} WHERE id=?`).get(id) as
      { activation_operation_id: string | null; activation_binding_digest: string | null; readiness_revision: number } | undefined;
    if (!row) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
    assertRevision(row.readiness_revision, "readiness");
    return Object.freeze({
      ...(row.activation_operation_id ? { activationOperationId: row.activation_operation_id } : {}),
      ...(row.activation_binding_digest ? { bindingDigest: row.activation_binding_digest } : {}),
      readinessRevision: row.readiness_revision,
    });
  }

  resourceTargets(): readonly ActivationResourceTarget[] {
    const targets: ActivationResourceTarget[] = [];
    for (const { id } of this.resources.db.prepare("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>) {
      targets.push(Object.freeze({ kind: "workspace" as const, id, revision: this.recordReadiness("workspace", id) }));
    }
    for (const { id } of this.resources.db.prepare("SELECT id FROM provider_instances ORDER BY id").all() as Array<{ id: string }>) {
      targets.push(Object.freeze({ kind: "provider" as const, id, revision: this.recordReadiness("provider", id) }));
    }
    return Object.freeze(targets);
  }

  /**
   * Durable acceptance of the local `verify` request; an identical
   * actor+commandId returns the original receipt so a lost CLI response is
   * retry-safe.
   */
  begin(input: { id: string; actorId: string; commandId: string; kind: ActivationOperationKind; requestHash: string; ownerContext: ActivationOperation["ownerContext"]; resourceBinding: ActivationResourceBinding }): ActivationOperation {
    this.assertWritable();
    assertOperationId(input.id);
    if (input.kind !== "activation" && input.kind !== "restore_check") throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
    if (!input.actorId || !input.commandId || input.requestHash.length < 1) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
    if (!input.resourceBinding.workspaceId || !input.resourceBinding.providerInstanceId) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
    return this.resources.db.transaction(() => {
      const stored = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE actor_id=? AND command_id=?").get(input.actorId, input.commandId) as RawOperation | undefined;
      if (stored) {
        // A reused command must describe exactly the same activation request.
        if (stored.kind !== input.kind || stored.request_hash !== input.requestHash || stored.resource_binding_json !== JSON.stringify(input.resourceBinding)) {
          throw new ActivationError("ACTIVATION_EVIDENCE_INVALID", "Command ID was reused with a different activation request");
        }
        return this.materialize(stored);
      }
      const at = nowIso();
      this.resources.db.prepare(`INSERT INTO host_execution_operations(id,actor_id,command_id,kind,request_hash,state,revision,owner_context_json,resource_binding_json,evidence_json,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,'accepted',0,?,?,NULL,NULL,?,?)`).run(input.id, input.actorId, input.commandId, input.kind, input.requestHash,
        JSON.stringify({ ownerId: input.ownerContext.ownerId, ownerGeneration: input.ownerContext.ownerGeneration, resourceKeys: [...input.ownerContext.resourceKeys] }),
        JSON.stringify({ workspaceId: input.resourceBinding.workspaceId, providerInstanceId: input.resourceBinding.providerInstanceId }), at, at);
      return this.materialize(this.requireRow(input.id));
    })();
  }

  /** accepted -> checking; every later transition is fenced by this revision. */
  claim(id: string): ActivationOperation {
    this.assertWritable();
    return this.resources.db.transaction(() => {
      const current = this.requireRow(id);
      if (current.state === "checking") return this.materialize(current);
      if (current.state !== "accepted") throw new ActivationError("ACTIVATION_EVIDENCE_INVALID", "Only an accepted activation request can be checked");
      const changed = this.resources.db.prepare("UPDATE host_execution_operations SET state='checking',revision=revision+1,updated_at=? WHERE id=? AND state='accepted' AND revision=?").run(nowIso(), id, current.revision);
      if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCE_CHANGED", undefined, true);
      return this.materialize(this.requireRow(id));
    })();
  }

  /** Persist one verified reachable binding, or a rejection with concrete blocking reasons. */
  settle(id: string, input: { at: string; evidence: ActivationEvidenceRecord } | { at: string; rejected: readonly ActivationReasonCode[] }): ActivationOperation {
    this.assertWritable();
    return this.resources.db.transaction(() => {
      const current = this.requireRow(id);
      if (current.state !== "checking") throw new ActivationError("ACTIVATION_EVIDENCE_INVALID", "Only a checking activation request can be settled");
      if (current.kind !== "activation") throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
      if ("evidence" in input) {
        const evidence = input.evidence;
        if (!evidence || evidence.operationId !== id || evidence.requestHash !== current.request_hash || evidence.kind !== current.kind ||
            !/^[a-f0-9]{64}$/.test(evidence.digest) || !evidence.validUntil) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
        this.resources.db.prepare("UPDATE host_execution_operations SET state='ready',revision=revision+1,evidence_json=?,updated_at=? WHERE id=? AND state='checking' AND revision=?")
          .run(JSON.stringify({ id: evidence.id, digest: evidence.digest, validUntil: evidence.validUntil, workspaceId: evidence.workspaceId, providerInstanceId: evidence.providerInstanceId, payload: evidence.payload }), input.at, id, current.revision);
      } else {
        const reasons = sortedReasons(input.rejected);
        if (!reasons.length) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
        this.resources.db.prepare("UPDATE host_execution_operations SET state='rejected',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state='checking' AND revision=?")
          .run(JSON.stringify({ reasonCodes: reasons }), input.at, id, current.revision);
      }
      return this.materialize(this.requireRow(id));
    })();
  }

  /**
   * The one short activation transaction. The `activate` receipt is created
   * (or resumed by identical actor+commandId), the fresh resource revisions are
   * CAS'd against the evidence, and either every resource row is updated with
   * the evidence reference and the evidence receipt is completed — or the typed
   * reasons are persisted and no resource row changes. The decision callback
   * runs inside the transaction and must stay synchronous; every fact it needs
   * is captured before the transaction.
   */
  commitActivation(input: {
    id: string; actorId: string; commandId: string; evidenceOperationId: string;
    ownerContext: ActivationOperation["ownerContext"]; at: string;
    decide: (facts: { workspaceId: string; providerInstanceId: string; revisions: Readonly<Record<string, number>> }) => ActivationDecision;
  }): ActivationWriteOutcome {
    this.assertWritable();
    assertOperationId(input.id);
    const requestHash = activationConsumeRequestHash(input.evidenceOperationId);
    return this.resources.db.transaction(() => {
      const stored = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE actor_id=? AND command_id=?").get(input.actorId, input.commandId) as RawOperation | undefined;
      if (stored && (stored.kind !== "activation" || stored.request_hash !== requestHash)) {
        throw new ActivationError("ACTIVATION_EVIDENCE_INVALID", "Command ID was reused with a different activation request");
      }
      if (stored?.state === "completed") return Object.freeze({ kind: "ready" as const, operation: this.materialize(stored) });
      if (stored?.state === "rejected" || stored?.state === "outcome_unknown") {
        return Object.freeze({ kind: "invalidated" as const, operation: this.materialize(stored), reasonCodes: this.reasonsOf(stored) });
      }
      // The evidence receipt is the activation source; it must still be fresh.
      const evidence = this.requireRow(input.evidenceOperationId);
      if (evidence.kind !== "activation" || evidence.state !== "ready" || !evidence.evidence_json) {
        throw new ActivationError("ACTIVATION_VERIFICATION_MISSING", "Activation evidence must be verified and not yet consumed");
      }
      const binding = JSON.parse(evidence.resource_binding_json) as ActivationResourceBinding;
      let current: RawOperation;
      if (stored) current = stored;
      else {
        this.resources.db.prepare(`INSERT INTO host_execution_operations(id,actor_id,command_id,kind,request_hash,state,revision,owner_context_json,resource_binding_json,evidence_json,result_json,created_at,updated_at)
          VALUES(?,?,?,?,?,'accepted',0,?,?,NULL,NULL,?,?)`).run(input.id, input.actorId, input.commandId, "activation", requestHash,
          JSON.stringify({ ownerId: input.ownerContext.ownerId, ownerGeneration: input.ownerContext.ownerGeneration, resourceKeys: [...input.ownerContext.resourceKeys] }),
          evidence.resource_binding_json, input.at, input.at);
        current = this.requireRow(input.id);
      }
      const revisions: Record<string, number> = {
        [`workspace:${binding.workspaceId}`]: this.recordReadiness("workspace", binding.workspaceId),
        [`provider:${binding.providerInstanceId}`]: this.recordReadiness("provider", binding.providerInstanceId),
      };
      const decision = input.decide({ workspaceId: binding.workspaceId, providerInstanceId: binding.providerInstanceId, revisions: Object.freeze({ ...revisions }) });
      const activations = decision.activations ?? [];
      for (const target of activations) if (!/^[a-f0-9]{64}$/.test(target.bindingDigest)) throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
      const conflict = activations.some((target) => target.revision !== revisions[`${target.kind}:${target.id}`]);
      const reasons = sortedReasons([...(decision.reasonCodes ?? []), ...(conflict ? ["ACTIVATION_SOURCE_BINDING_CHANGED" as const] : [])]);
      if (!activations.length || conflict || reasons.length) {
        const rejected = reasons.length ? reasons : ["ACTIVATION_RESOURCES_UNVERIFIED"] as const;
        const cleared = this.resources.db.prepare("UPDATE host_execution_operations SET state='rejected',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state=? AND revision=?")
          .run(JSON.stringify({ reasonCodes: rejected }), input.at, current.id, current.state, current.revision);
        if (cleared.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCE_CHANGED", undefined, true);
        return Object.freeze({ kind: "invalidated" as const, operation: this.materialize(this.requireRow(current.id)), reasonCodes: rejected });
      }
      for (const target of activations) {
        this.writeActivatedResource(target, { evidenceOperationId: input.evidenceOperationId, at: input.at });
      }
      const recorded = activations.map((target) => ({ kind: target.kind, id: target.id, revision: revisions[`${target.kind}:${target.id}`]! + 1 }));
      const completedEvidence = this.resources.db.prepare("UPDATE host_execution_operations SET state='completed',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state='ready' AND revision=?")
        .run(JSON.stringify({ reasonCodes: [], activations: recorded, evidenceId: input.evidenceOperationId, consumedBy: current.id }), input.at, input.evidenceOperationId, evidence.revision);
      if (completedEvidence.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCE_CHANGED", undefined, true);
      const changed = this.resources.db.prepare("UPDATE host_execution_operations SET state='completed',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state=? AND revision=?")
        .run(JSON.stringify({ reasonCodes: [], activations: recorded, ...(decision.result ?? {}), evidenceId: input.evidenceOperationId }), input.at, current.id, current.state, current.revision);
      if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCE_CHANGED", undefined, true);
      return Object.freeze({ kind: "ready" as const, operation: this.materialize(this.requireRow(current.id)) });
    })();
  }

  /**
   * Withdraw one resource's activation without touching original recovery
   * identities: the reference is cleared, the readiness revision bumps and the
   * resource returns to its unverified state, and the referenced receipt keeps
   * its activation record while gaining the invalidation reasons — all in one
   * transaction, so a crash can never leave an `active` row without evidence.
   */
  withdrawReadiness(kind: ActivationResourceKind, id: string, input: { at: string; reasonCodes: readonly ActivationReasonCode[] }): void {
    this.assertWritable();
    this.resources.db.transaction(() => {
      const previous = this.referencedOperation(kind, id);
      if (kind === "workspace") {
        const record = this.resources.workspace(id);
        if (!record) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
        const state = record.state === "disabled" ? "disabled" : "needs_verification";
        const changed = this.resources.db.prepare("UPDATE workspaces SET state=?,activation_operation_id=NULL,activation_binding_digest=NULL,readiness_revision=readiness_revision+1,updated_at=? WHERE id=?")
          .run(state, input.at, id);
        if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
      } else {
        const record = this.resources.provider(id);
        if (!record) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
        const disabled = record.state === "disabled";
        const verification: ProviderVerification = disabled ? record.verification : { ...record.verification, state: "unverified" };
        const changed = this.resources.db.prepare("UPDATE provider_instances SET state=?,verification_json=?,activation_operation_id=NULL,activation_binding_digest=NULL,readiness_revision=readiness_revision+1,updated_at=? WHERE id=?")
          .run(disabled ? "disabled" : "unconfigured", JSON.stringify(verification), input.at, id);
        if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
      }
      if (previous) this.annotateInvalidation(previous.id, input);
    })();
  }

  /** Record a settled non-activation outcome; the operation receipt is preserved. */
  settleOutcome(id: string, state: "rejected" | "outcome_unknown", input: { at: string; reasonCodes?: readonly ActivationReasonCode[]; result?: Readonly<object> }): ActivationOperation {
    this.assertWritable();
    return this.resources.db.transaction(() => {
      const current = this.requireRow(id);
      if (current.state !== "checking" && current.state !== "accepted") throw new ActivationError("ACTIVATION_EVIDENCE_INVALID");
      this.resources.db.prepare("UPDATE host_execution_operations SET state=?,revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state=? AND revision=?")
        .run(state, JSON.stringify({ reasonCodes: sortedReasons(input.reasonCodes ?? []), ...(input.result ?? {}) }), input.at, id, current.state, current.revision);
      return this.materialize(this.requireRow(id));
    })();
  }

  private annotateInvalidation(operationId: string, input: { at: string; reasonCodes: readonly ActivationReasonCode[] }): void {
    if (!input.reasonCodes.length) return;
    const current = this.requireRow(operationId);
    if (current.state !== "completed") return;
    const result = current.result_json ? JSON.parse(current.result_json) as Record<string, unknown> : {};
    this.resources.db.prepare("UPDATE host_execution_operations SET result_json=?,revision=revision+1,updated_at=? WHERE id=? AND state='completed' AND revision=?")
      .run(JSON.stringify({ ...result, reasonCodes: sortedReasons(input.reasonCodes), invalidated: true, invalidatedAt: input.at }), input.at, operationId, current.revision);
  }

  private writeActivatedResource(target: ActivationResourceTarget & { bindingDigest: string; providerVerification?: ProviderVerification }, input: { evidenceOperationId: string; at: string }): void {
    if (target.kind === "workspace") {
      const changed = this.resources.db.prepare("UPDATE workspaces SET state='active',activation_operation_id=?,activation_binding_digest=?,readiness_revision=readiness_revision+1,updated_at=? WHERE id=? AND state<>'disabled'")
        .run(input.evidenceOperationId, target.bindingDigest, input.at, target.id);
      if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
      return;
    }
    const verification: ProviderVerification = target.providerVerification ?? { state: "unverified", capabilities: [] };
    const changed = this.resources.db.prepare("UPDATE provider_instances SET state='configured',verification_json=?,activation_operation_id=?,activation_binding_digest=?,readiness_revision=readiness_revision+1,updated_at=? WHERE id=? AND state<>'disabled'")
      .run(JSON.stringify(verification), input.evidenceOperationId, target.bindingDigest, input.at, target.id);
    if (changed.changes !== 1) throw new ActivationError("ACTIVATION_RESOURCES_UNVERIFIED");
  }

  private reasonsOf(row: RawOperation): readonly ActivationReasonCode[] {
    if (!row.result_json) return Object.freeze([]);
    try { return sortedReasons((JSON.parse(row.result_json) as { reasonCodes?: ActivationReasonCode[] }).reasonCodes ?? []); }
    catch { return Object.freeze([]); }
  }

  private assertWritable(): void {
    this.options.guard();
    if (!this.available) throw new ActivationError("ACTIVATION_SCHEMA_UNAVAILABLE", "Execution activation schema is unavailable");
  }

  private requireRow(id: string): RawOperation {
    const row = this.resources.db.prepare("SELECT * FROM host_execution_operations WHERE id=?").get(id) as RawOperation | undefined;
    if (!row) throw new ActivationError("ACTIVATION_OPERATION_NOT_FOUND");
    return row;
  }

  private materialize(row: RawOperation): ActivationOperation {
    const evidence = row.evidence_json ? JSON.parse(row.evidence_json) as { id: string; digest: string; validUntil?: string; payload?: object } : undefined;
    const result = row.result_json ? JSON.parse(row.result_json) as { reasonCodes?: ActivationReasonCode[]; activations?: ActivationResourceTarget[] } : undefined;
    return Object.freeze({
      id: row.id, actorId: row.actor_id, commandId: row.command_id, kind: row.kind, requestHash: row.request_hash, state: row.state, revision: row.revision,
      ownerContext: Object.freeze(JSON.parse(row.owner_context_json) as ActivationOperation["ownerContext"]),
      resourceBinding: Object.freeze(JSON.parse(row.resource_binding_json) as ActivationResourceBinding),
      ...(evidence ? { evidence: Object.freeze({ id: evidence.id, digest: evidence.digest, ...(evidence.validUntil ? { validUntil: evidence.validUntil } : {}),
        ...(evidence.payload && typeof evidence.payload === "object" ? { payload: Object.freeze(evidence.payload) } : {}) }) } : {}),
      ...(result ? { result: Object.freeze({ reasonCodes: sortedReasons(result.reasonCodes ?? []), activations: Object.freeze(result.activations ?? []) }) } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  }
}

export type ActivationDecision = Readonly<{
  activations?: readonly (ActivationResourceTarget & { bindingDigest: string; providerVerification?: ProviderVerification })[];
  reasonCodes?: readonly ActivationReasonCode[];
  result?: Readonly<object>;
}>;

export function createActivationOperationStore(resources: ActivationStoreResource, options: ActivationOperationStoreOptions): ActivationOperationStore {
  if (typeof options?.guard !== "function") throw new CatalogError("ACTIVATION_OWNER_INVALID");
  return new ActivationOperationStore(resources, options);
}

export function activationRequestHash(input: { kind: ActivationOperationKind; workspaceId: string; providerInstanceId: string; requestFormatVersion: number }): string {
  return digest({ requestFormatVersion: input.requestFormatVersion, kind: input.kind, workspaceId: input.workspaceId, providerInstanceId: input.providerInstanceId });
}

/** The `activate` receipt request hash; reusing a command ID must name the same evidence. */
export function activationConsumeRequestHash(evidenceOperationId: string): string {
  return digest({ requestFormatVersion: 1, kind: "activation", evidenceOperationId });
}

export function newActivationOperationId(): string { return randomUUID(); }
export { digest as activationDigest };

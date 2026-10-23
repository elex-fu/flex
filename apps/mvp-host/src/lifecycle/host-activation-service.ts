import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { canonicalPath, type HostOwnerHandle } from "./host-owner.js";
import type { ProviderInstanceRecord, ProviderVerification, WorkspaceRecord } from "../storage/catalog-store.js";
import { checkoutKey } from "../storage/migrations/007-catalog.js";
import type { WorkspaceGitQuery } from "../workspace/workspace-registry.js";
import {
  activationConsumeRequestHash, activationRequestHash, newActivationOperationId, ActivationError,
  type ActivationOperation, type ActivationOperationStore, type ActivationReasonCode,
  type ActivationResourceReadiness, type ActivationResourceTarget,
} from "../storage/activation-store.js";
import {
  activationBindingDigest, directoryIdentity, localActivationFacts, parseActivationPayload, privateDirectoryOverlap, providerLocalChanges,
  type ActivationEvidencePayload, type ActivationLoadFacts, type HostActivationLoad, type LocalWorkspaceFacts,
  type ProviderRuntimeFacts, type ProviderObservation, type SupervisionContractFacts, type WorkspaceObservation,
} from "./host-activation-load.js";

/**
 * `HostActivationService` implements design §6.3 steps 1–5 for the local
 * management flow:
 *
 *   verify   — read-only checks under a maintenance (or host) owner context.
 *              Original producers, the restore gate, managed-query directory
 *              identity and the actual Provider executable/SDK/adapter/
 *              configuration/supervision facts are matched against saved
 *              compatibility evidence. It never runs a real Provider scenario
 *              and never launches a Provider.
 *   activate — one short SQL transaction CASing the resource revisions against
 *              the recorded evidence and writing the activation reference and
 *              binding digest, or persisting the concrete blocking reasons.
 *   inspect  — read-only receipt lookup.
 *
 * A missing managed-query executor, an unverified supervision contract or
 * missing compatibility evidence are typed refusals; nothing falls back to a
 * raw Git, helper or Provider launch. The same filesystem/installed-facts
 * observation backs verify, the write gate and the startup load, so no two
 * code paths can disagree about what "unchanged" means.
 */

export type ManagedQueryPort = Readonly<{
  /** The exact existing `WorkspaceRegistry` query port; only a proven managed runner may implement it. */
  readOnlyGit: WorkspaceGitQuery;
  /** Same contract as `ManagedWorkspaceQuery.prepare()`; production wires the managed query service. */
  prepare(): Promise<Readonly<{ ready: true }> | Readonly<{ ready: false; code: string }>>;
  /** The managed stop report; never a process-group assumption. */
  closeAndWait(deadlineMs: number): Promise<Readonly<{ producerStopped: boolean; clean: boolean }>>;
}>;

export type ManagedQueryExecutorFactory = (input: { kind: "activation"; privateRoots: readonly string[]; operationId: string }) => Promise<ManagedQueryPort | undefined>;

export type ActivationBindingSnapshot = Readonly<{
  workspace: WorkspaceObservation;
  provider: ProviderObservation;
}>;

export type ActivationBindingSnapshotResult =
  | Readonly<{ ready: true; value: ActivationBindingSnapshot }>
  | Readonly<{ ready: false; reasonCodes: readonly ActivationReasonCode[] }>;

export type ActivationBindingReconcileResult =
  | Readonly<{ ready: true; value: Readonly<{ workspace: LocalWorkspaceFacts; provider: ProviderObservation }> }>
  | Readonly<{ ready: false; reasonCodes: readonly ActivationReasonCode[] }>;

export type ActivationBindingSource = {
  /** Measure every fact behind one binding. The injected managed query port is the only Git access. */
  snapshot(input: { workspace: WorkspaceRecord; provider: ProviderInstanceRecord; executor: ManagedQueryPort; operationId: string }): Promise<ActivationBindingSnapshotResult>;
  /** Filesystem/installed-facts-only re-measure for the activate preflight; no Git, no Provider launch. */
  reconcile(input: { workspace: WorkspaceRecord; provider: ProviderInstanceRecord }): ActivationBindingReconcileResult;
};

export type HostActivationFacts = {
  db: Database.Database;
  owner: HostOwnerHandle;
  catalog: {
    workspace(id: string): WorkspaceRecord | undefined;
    workspaces(): readonly WorkspaceRecord[];
    provider(id: string): ProviderInstanceRecord | undefined;
    providers(): readonly ProviderInstanceRecord[];
    /**
     * Persist a verification-decided checkout identity for a SQL-bootstrapped
     * local row (mirrors `WorkspaceRegistry.registerLocal`). Wired by the
     * maintenance CLI, where the owner is the live writer; an embedder that
     * leaves it unwired stays fail-closed — the row keeps its unknown identity
     * and every later reconcile refuses it.
     */
    putWorkspace?(input: Omit<WorkspaceRecord, "createdAt" | "updatedAt">): WorkspaceRecord;
  };
  /** Current original-producer inventory (reuses `inspectCatalogStartupReadiness`); absent stays blocking. */
  readiness?: () => Readonly<{ ready: boolean }>;
};

export type HostActivationServiceOptions = {
  facts: HostActivationFacts;
  operations: ActivationOperationStore;
  /** Readiness probe shared with the startup load and the write gate. */
  load: HostActivationLoad;
  /** Local management actor; there is no remote activation RPC in this delivery. */
  actorId: string;
  /** The one shared observation; when absent it is built from `compatibilityEvidencePath` and the installed-facts inputs. */
  observation?: ActivationLoadFacts;
  /** Host-private compatibility evidence log written by adapters/recovery inspectors. */
  compatibilityEvidencePath?: string;
  privateRoots?: readonly string[];
  /** Trusted installed-contract evidence; undefined means the platform supervisor contract is unavailable. */
  supervision?: () => SupervisionContractFacts | undefined;
  /** Actual installed adapter/SDK facts; an absent component cannot match recorded evidence. */
  runtime?: (provider: ProviderInstanceRecord) => ProviderRuntimeFacts | undefined;
  bindingSource?: ActivationBindingSource;
  /** Main injects a proven managed executor; without one the service stays fail-closed. */
  executorFactory?: ManagedQueryExecutorFactory;
  now?: () => Date;
  /** Default 24h from observation; an input-digest change invalidates immediately. */
  evidenceTtlMs?: number;
  /** Reuses the existing original-producer inventory facts; no runtime HostCatalog is built. */
  validateProducers?: (facts: HostActivationFacts) => readonly ActivationReasonCode[];
};

export class ActivationServiceError extends Error {
  constructor(readonly code: string, message = code, readonly reasonCodes: readonly ActivationReasonCode[] = []) {
    super(message);
    this.name = "ActivationServiceError";
  }
}

export const DEFAULT_ACTIVATION_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const QUERY_MAX_BUFFER_BYTES = 16 * 1024;
const QUERY_TIMEOUT_MS = 5_000;

/** Pure step-1 producer inventory reuse: unresolved original producers keep blocking. */
export function activationProducerBlockers(facts: HostActivationFacts): readonly ActivationReasonCode[] {
  if (!facts.readiness) return Object.freeze(["ORIGINAL_PRODUCERS_UNRESOLVED"]);
  try { return facts.readiness().ready ? Object.freeze([]) : Object.freeze(["ORIGINAL_PRODUCERS_UNRESOLVED"]); }
  catch { return Object.freeze(["ORIGINAL_PRODUCERS_UNRESOLVED"]); }
}

function sortedReasons(values: readonly ActivationReasonCode[]): readonly ActivationReasonCode[] {
  return Object.freeze([...new Set(values)].sort()) as readonly ActivationReasonCode[];
}

export class HostActivationService {
  readonly observation: ActivationLoadFacts;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly validateProducers: (facts: HostActivationFacts) => readonly ActivationReasonCode[];
  private readonly bindingSource: ActivationBindingSource;
  private readonly privateRoots: readonly string[];
  private executor: ManagedQueryPort | undefined;
  private closed = false;

  constructor(private readonly options: HostActivationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.evidenceTtlMs ?? DEFAULT_ACTIVATION_EVIDENCE_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 0) throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "Invalid activation evidence TTL");
    this.privateRoots = privateRootsFor(options.facts, options.privateRoots ?? []);
    this.validateProducers = options.validateProducers ?? activationProducerBlockers;
    if (options.observation) this.observation = options.observation;
    else {
      if (!options.compatibilityEvidencePath) throw new ActivationServiceError("ACTIVATION_OBSERVATION_UNAVAILABLE", "Activation needs a shared observation or the compatibility evidence path");
      this.observation = localActivationFacts({
        ...(options.privateRoots ? { privateRoots: options.privateRoots } : {}),
        compatibilityEvidencePath: options.compatibilityEvidencePath,
        ...(options.supervision ? { supervision: options.supervision } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
      });
    }
    this.bindingSource = options.bindingSource ?? new DefaultActivationBindingSource({ observation: this.observation, privateRoots: this.privateRoots });
  }

  /** Read-only receipt lookup. */
  inspect(operationId: string): ActivationOperation | undefined {
    return this.options.operations.operation(operationId);
  }

  /** Read-only readiness projection for every registered resource. */
  readiness(): readonly ActivationResourceReadiness[] {
    return this.options.load.scan({ workspaces: this.options.facts.catalog.workspaces(), providers: this.options.facts.catalog.providers() });
  }

  resourceReadiness(kind: "workspace" | "provider", id: string): ActivationResourceReadiness | undefined {
    const record = kind === "workspace" ? this.options.facts.catalog.workspace(id) : this.options.facts.catalog.provider(id);
    if (!record) return undefined;
    return kind === "workspace" ? this.options.load.workspace(record as WorkspaceRecord) : this.options.load.provider(record as ProviderInstanceRecord);
  }

  /**
   * Fail-closed write gate: a resource whose inputs changed, expired or cannot
   * be checked is withdrawn (state reset, readiness revision bumped, reasons
   * recorded on the receipt) and the caller is refused with those reasons.
   */
  assertReadyForWrite(input: { workspaceId: string; providerInstanceId: string }): void {
    if (this.closed) throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "Activation service is closed");
    this.assertOwner();
    const { facts, load } = this.options;
    const workspaceRecord = facts.catalog.workspace(input.workspaceId);
    const providerRecord = facts.catalog.provider(input.providerInstanceId);
    if (!workspaceRecord || !providerRecord) {
      throw new ActivationServiceError("ACTIVATION_RESOURCES_UNVERIFIED", "Activation target is not registered", ["ACTIVATION_RESOURCES_UNVERIFIED"]);
    }
    const workspace = load.workspace(workspaceRecord);
    const provider = load.provider(providerRecord);
    if (workspace.ready && provider.ready) return;
    const reasonCodes = sortedReasons([...workspace.reasonCodes, ...provider.reasonCodes]);
    // The evidence binds a pair: when either side cannot be proven, every
    // resource still referencing that evidence is withdrawn in one step (a
    // disabled or never-activated resource carries no reasons and is left
    // untouched). `assertReadyForWrite` is the explicit write decision, so the
    // read-only scan alone never erases the receipt.
    if (load.available) {
      const at = this.now().toISOString();
      for (const [kind, id, verdict] of [
        ["workspace", workspaceRecord.workspaceId, workspace],
        ["provider", providerRecord.providerInstanceId, provider],
      ] as const) {
        if (!verdict.ready && !verdict.reasonCodes.length) continue;
        load.store.withdrawReadiness(kind, id, { at, reasonCodes: verdict.reasonCodes.length ? verdict.reasonCodes : reasonCodes });
      }
    }
    throw new ActivationServiceError(reasonCodes[0] ?? "ACTIVATION_RESOURCES_UNVERIFIED", "Activation readiness was withdrawn", reasonCodes.length ? reasonCodes : ["ACTIVATION_RESOURCES_UNVERIFIED"]);
  }

  /** `verify --workspace <id> --provider <id>`: one durable receipt, one evidence artifact, zero Provider scenarios. */
  async verify(input: { workspaceId: string; providerInstanceId: string; commandId: string }): Promise<Readonly<{ operationId: string; evidenceId: string; evidenceDigest: string; validUntil: string }>> {
    if (this.closed) throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "Activation service is closed");
    const { facts, operations } = this.options;
    const at = this.now();
    this.assertOwner();
    if (!operations.available) throw new ActivationServiceError("ACTIVATION_SCHEMA_UNAVAILABLE", "Execution activation schema is unavailable", ["ACTIVATION_SCHEMA_UNAVAILABLE"]);
    const workspace = facts.catalog.workspace(input.workspaceId);
    const provider = facts.catalog.provider(input.providerInstanceId);
    if (!workspace || !provider) throw new ActivationServiceError("ACTIVATION_RESOURCES_UNVERIFIED", "Activation target is not registered", ["ACTIVATION_RESOURCES_UNVERIFIED"]);
    const requestHash = activationRequestHash({ kind: "activation", workspaceId: input.workspaceId, providerInstanceId: input.providerInstanceId, requestFormatVersion: 1 });
    const operation = operations.begin({
      id: newActivationOperationId(), actorId: this.options.actorId, commandId: input.commandId, kind: "activation", requestHash,
      ownerContext: { ownerId: facts.owner.ownerId, ownerGeneration: facts.owner.generation, resourceKeys: [...facts.owner.resourceKeys] },
      resourceBinding: { workspaceId: input.workspaceId, providerInstanceId: input.providerInstanceId },
    });
    // The evidence ID is the verify operation ID, so `activate --evidence <id>` names this receipt.
    if (operation.state === "ready" || operation.state === "completed") return this.verifiedResult(operation);
    if (operation.state === "rejected" || operation.state === "outcome_unknown") {
      const reasons = operation.result?.reasonCodes ?? [];
      throw new ActivationServiceError(reasons[0] ?? "ACTIVATION_VERIFICATION_MISSING", "The stored verification attempt did not produce usable evidence", reasons);
    }
    operations.claim(operation.id);
    const reasonCodes: ActivationReasonCode[] = [...this.stepOneBlockers()];
    if (!reasonCodes.length && workspace.state === "disabled") reasonCodes.push("WORKSPACE_NOT_VERIFIED");
    if (!reasonCodes.length && provider.state === "disabled") reasonCodes.push("PROVIDER_NOT_VERIFIED");
    let executor: ManagedQueryPort | undefined;
    if (!reasonCodes.length) {
      executor = await this.acquireExecutor(operation.id);
      if (!executor) reasonCodes.push("WORKSPACE_QUERY_EXECUTOR_UNAVAILABLE");
      else {
        let readiness: Awaited<ReturnType<ManagedQueryPort["prepare"]>>;
        try { readiness = await executor.prepare(); }
        catch { readiness = { ready: false, code: "WORKSPACE_QUERY_UNVERIFIED" }; }
        if (!readiness.ready) reasonCodes.push("WORKSPACE_QUERY_UNVERIFIED");
      }
    }
    if (!reasonCodes.length && executor) {
      const observed = await this.bindingSource.snapshot({ workspace, provider, executor, operationId: operation.id });
      if (observed.ready) {
        // A SQL-bootstrapped local row keeps its checkout identity unknown; the
        // snapshot just decided it through the managed toplevel query. Persist
        // that verified identity (mirroring registerLocal) so the activate
        // preflight and the post-activation startup load reconcile the same
        // row this evidence binds. Unwired embedders stay fail-closed.
        if (workspace.kind === "local" && !workspace.worktreeRoot && observed.value.workspace.worktreeRoot !== workspace.worktreeRoot) {
          facts.catalog.putWorkspace?.({
            workspaceId: workspace.workspaceId, canonicalRoot: workspace.canonicalRoot,
            worktreeRoot: observed.value.workspace.worktreeRoot, checkoutKey: observed.value.workspace.checkoutKey,
            kind: workspace.kind, state: workspace.state, repositoryId: workspace.repositoryId, capabilities: [...workspace.capabilities],
            ...(workspace.registrationOperationId ? { registrationOperationId: workspace.registrationOperationId } : {}),
          });
        }
        const revisions = Object.freeze({
          workspace: operations.recordReadiness("workspace", input.workspaceId),
          provider: operations.recordReadiness("provider", input.providerInstanceId),
        });
        const validUntil = new Date(at.getTime() + this.ttlMs).toISOString();
        const payload: ActivationEvidencePayload = Object.freeze({
          v: 1, kind: "activation", observedAt: at.toISOString(), validUntil, resourceRevisions: revisions,
          workspace: observed.value.workspace,
          provider: observed.value.provider,
        });
        const settled = operations.settle(operation.id, {
          at: at.toISOString(),
          evidence: {
            id: operation.id, kind: "activation", requestHash, digest: activationBindingDigest(payload), validUntil,
            workspaceId: input.workspaceId, providerInstanceId: input.providerInstanceId, operationId: operation.id, payload,
          },
        });
        return this.verifiedResult(settled);
      }
      reasonCodes.push(...observed.reasonCodes);
    }
    const rejected = sortedReasons(reasonCodes.length ? reasonCodes : ["ACTIVATION_INSPECT_UNVERIFIED"]);
    operations.settle(operation.id, { at: at.toISOString(), rejected });
    throw new ActivationServiceError(rejected[0]!, "Activation verification did not produce a reachable binding", rejected);
  }

  /** `activate --evidence <evidenceId> --command-id <id>`: one short CAS transaction. */
  activate(input: { evidenceId: string; commandId: string }): Readonly<{ operationId: string; activations: readonly ActivationResourceTarget[]; reused: boolean }> {
    if (this.closed) throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "Activation service is closed");
    const { facts, operations } = this.options;
    const at = this.now();
    this.assertOwner();
    if (!operations.available) throw new ActivationServiceError("ACTIVATION_SCHEMA_UNAVAILABLE", "Execution activation schema is unavailable", ["ACTIVATION_SCHEMA_UNAVAILABLE"]);
    const evidence = operations.operation(input.evidenceId);
    if (!evidence) throw new ActivationServiceError("ACTIVATION_OPERATION_NOT_FOUND", "Unknown activation evidence ID", ["ACTIVATION_OPERATION_NOT_FOUND"]);
    if (evidence.kind !== "activation") throw new ActivationServiceError("ACTIVATION_EVIDENCE_INVALID", "The referenced operation is not activation evidence", ["ACTIVATION_EVIDENCE_INVALID"]);
    if (evidence.state === "completed") return this.consumedResult(evidence, input.commandId);
    const payload = parseActivationPayload(evidence);
    if (!payload) throw new ActivationServiceError("ACTIVATION_VERIFICATION_MISSING", "Activation evidence must be verified and not yet consumed", ["ACTIVATION_VERIFICATION_MISSING"]);
    const workspace = facts.catalog.workspace(evidence.resourceBinding.workspaceId);
    const provider = facts.catalog.provider(evidence.resourceBinding.providerInstanceId);
    if (!workspace || !provider) throw new ActivationServiceError("ACTIVATION_RESOURCES_UNVERIFIED", "Activation target is not registered", ["ACTIVATION_RESOURCES_UNVERIFIED"]);
    // Facts are captured before the transaction; the transaction only CASes revisions.
    const reconciled = this.bindingSource.reconcile({ workspace, provider });
    const preflight: readonly ActivationReasonCode[] = reconciled.ready
      ? reconcileObservable(payload, reconciled.value, at)
      : activationPreflightRefusals(payload, provider, reconciled.reasonCodes, at);
    const persisted = operations.operationForCommand(this.options.actorId, input.commandId);
    let outcome: ReturnType<ActivationOperationStore["commitActivation"]>;
    try {
      outcome = operations.commitActivation({
        id: newActivationOperationId(), actorId: this.options.actorId, commandId: input.commandId, evidenceOperationId: evidence.id,
        ownerContext: { ownerId: facts.owner.ownerId, ownerGeneration: facts.owner.generation, resourceKeys: [...facts.owner.resourceKeys] },
        at: at.toISOString(),
        decide: ({ revisions }) => {
          const reasons: ActivationReasonCode[] = [...preflight];
          const workspaceKey = `workspace:${workspace.workspaceId}`;
          const providerKey = `provider:${provider.providerInstanceId}`;
          // The evidence's recorded revisions are the CAS token: any later readiness
          // change (withdrawal, re-activation) means this source no longer binds.
          if (revisions[workspaceKey] !== payload.resourceRevisions.workspace || revisions[providerKey] !== payload.resourceRevisions.provider) {
            reasons.push("ACTIVATION_SOURCE_BINDING_CHANGED");
          }
          if (reasons.length) {
            return { reasonCodes: reasons, result: { evidenceId: evidence.id, evidenceDigest: evidence.evidence!.digest, observedAt: at.toISOString() } };
          }
          const bindingDigest = activationBindingDigest(payload);
          const verification: ProviderVerification = { state: "verified", runtimeVersion: payload.provider.runtimeVersion, capabilities: [...payload.provider.capabilities] };
          return {
            activations: [
              { kind: "workspace" as const, id: workspace.workspaceId, revision: revisions[workspaceKey]!, bindingDigest },
              { kind: "provider" as const, id: provider.providerInstanceId, revision: revisions[providerKey]!, bindingDigest, providerVerification: verification },
            ],
            result: { evidenceId: evidence.id, evidenceDigest: evidence.evidence!.digest, validUntil: payload.validUntil, observedAt: at.toISOString() },
          };
        },
      });
    } catch (error) {
      throw serviceError(error);
    }
    if (outcome.kind !== "ready") {
      throw new ActivationServiceError(outcome.reasonCodes[0] ?? "ACTIVATION_SOURCE_BINDING_CHANGED", "Activation CAS rejected the current resource binding", outcome.reasonCodes);
    }
    return this.activationResult(outcome.operation, persisted?.state === "completed");
  }

  /** Stop the managed query executor after local management work; a failed stop is reported, never claimed. */
  async close(deadlineMs = 5_000): Promise<Readonly<{ producerStopped: boolean; clean: boolean }>> {
    this.closed = true;
    const executor = this.executor;
    this.executor = undefined;
    if (!executor) return Object.freeze({ producerStopped: true, clean: true });
    try {
      const report = await executor.closeAndWait(deadlineMs);
      return Object.freeze({ producerStopped: report.producerStopped, clean: report.clean });
    } catch { return Object.freeze({ producerStopped: false, clean: false }); }
  }

  private verifiedResult(operation: ActivationOperation): Readonly<{ operationId: string; evidenceId: string; evidenceDigest: string; validUntil: string }> {
    const evidence = operation.evidence;
    if (!evidence?.digest || !evidence.validUntil) throw new ActivationServiceError("ACTIVATION_VERIFICATION_MISSING", "The stored verification attempt has no usable evidence", ["ACTIVATION_VERIFICATION_MISSING"]);
    return Object.freeze({ operationId: operation.id, evidenceId: operation.id, evidenceDigest: evidence.digest, validUntil: evidence.validUntil });
  }

  private consumedResult(evidence: ActivationOperation, commandId: string): Readonly<{ operationId: string; activations: readonly ActivationResourceTarget[]; reused: boolean }> {
    const stored = this.options.operations.operationForCommand(this.options.actorId, commandId);
    if (stored) {
      if (stored.kind !== "activation" || stored.requestHash !== activationConsumeRequestHash(evidence.id)) {
        throw new ActivationServiceError("ACTIVATION_EVIDENCE_INVALID", "Command ID was reused with a different activation request", ["ACTIVATION_EVIDENCE_INVALID"]);
      }
      if (stored.state === "completed") return this.activationResult(stored, true);
      if (stored.state === "rejected" || stored.state === "outcome_unknown") {
        const reasons = stored.result?.reasonCodes ?? [];
        throw new ActivationServiceError(reasons[0] ?? "ACTIVATION_SOURCE_BINDING_CHANGED", "The stored activation attempt did not activate the resources", reasons);
      }
    }
    // The evidence was already consumed; report the recorded activations without a new write.
    const recorded = evidence.result?.activations ?? [];
    if (!recorded.length) throw new ActivationServiceError("ACTIVATION_VERIFICATION_MISSING", "Activation evidence was consumed without recorded activations", ["ACTIVATION_VERIFICATION_MISSING"]);
    return Object.freeze({ operationId: evidence.id, activations: recorded, reused: true });
  }

  private activationResult(operation: ActivationOperation, reused: boolean): Readonly<{ operationId: string; activations: readonly ActivationResourceTarget[]; reused: boolean }> {
    return Object.freeze({ operationId: operation.id, activations: operation.result?.activations ?? Object.freeze([] as readonly ActivationResourceTarget[]), reused });
  }

  private stepOneBlockers(): readonly ActivationReasonCode[] {
    const reasons: ActivationReasonCode[] = [];
    const owner = this.options.facts.owner;
    if (owner.retainedReason) reasons.push("ORIGINAL_PRODUCERS_UNRESOLVED");
    if (this.restoreGatePending()) reasons.push("RESTORE_GATE_UNRESOLVED");
    reasons.push(...this.validateProducers(this.options.facts));
    return reasons;
  }

  private restoreGatePending(): boolean {
    try { return Boolean(this.options.facts.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get()); }
    catch { return true; }
  }

  private assertOwner(): void {
    const owner = this.options.facts.owner;
    try {
      owner.assertActive();
      owner.assertStorePath(this.options.facts.db.name);
    } catch { throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "Activation requires the active owner of this Store", ["ACTIVATION_OWNER_INVALID"]); }
    if (owner.recoveryOnly) throw new ActivationServiceError("ACTIVATION_OWNER_INVALID", "An unresolved retained recovery scope cannot activate resources", ["ACTIVATION_OWNER_INVALID"]);
  }

  private async acquireExecutor(operationId: string): Promise<ManagedQueryPort | undefined> {
    if (this.executor) return this.executor;
    if (!this.options.executorFactory) return undefined;
    try {
      const created = await this.options.executorFactory({ kind: "activation", privateRoots: this.privateRoots, operationId });
      if (!created) return undefined;
      this.executor = created;
      return created;
    } catch { return undefined; }
  }
}

/** Map a store error onto the service's typed errors; unknown failures stay fail-closed. */
function serviceError(error: unknown): ActivationServiceError {
  if (error instanceof ActivationServiceError) return error;
  if (error instanceof ActivationError) return new ActivationServiceError(error.code, error.message, [error.code] as readonly ActivationReasonCode[]);
  return new ActivationServiceError("ACTIVATION_RESOURCE_CHANGED", "Activation store rejected the write", ["ACTIVATION_RESOURCE_CHANGED"]);
}

export function privateRootsFor(facts: Pick<HostActivationFacts, "owner">, privateRoots: readonly string[]): readonly string[] {
  const owner = facts.owner;
  const roots = [...privateRoots];
  if (owner.databasePath !== ":memory:") roots.push(dirname(owner.databasePath));
  if (owner.identityDirectory) roots.push(owner.identityDirectory);
  if (owner.coordinationDirectory) roots.push(owner.coordinationDirectory);
  return Object.freeze([...new Set(roots)]);
}

/** Read-only reconciliation between the recorded evidence and freshly measured facts. */
export function reconcileObservable(
  evidence: ActivationEvidencePayload,
  current: Readonly<{ workspace: LocalWorkspaceFacts; provider: ProviderObservation }>,
  now: Date,
): readonly ActivationReasonCode[] {
  const reasons: ActivationReasonCode[] = [];
  if (evidence.workspace.canonicalRoot !== current.workspace.canonicalRoot || evidence.workspace.canonicalIdentity !== current.workspace.canonicalIdentity) reasons.push("WORKSPACE_IDENTITY_CHANGED");
  if (evidence.workspace.worktreeRoot !== current.workspace.worktreeRoot || evidence.workspace.worktreeIdentity !== current.workspace.worktreeIdentity) reasons.push("WORKSPACE_IDENTITY_CHANGED");
  if (evidence.workspace.checkoutKey !== current.workspace.checkoutKey) reasons.push("WORKSPACE_IDENTITY_CHANGED");
  if (evidence.workspace.repositoryId !== current.workspace.repositoryId) reasons.push("WORKSPACE_POLICY_CHANGED");
  if (evidence.provider.executablePath !== current.provider.executablePath || evidence.provider.executableDigest !== current.provider.executableDigest) reasons.push("PROVIDER_EXECUTABLE_CHANGED");
  if (evidence.provider.configFingerprint !== current.provider.configFingerprint) reasons.push("PROVIDER_CONFIG_CHANGED");
  if (evidence.provider.policyFingerprint !== current.provider.policyFingerprint) reasons.push("PROVIDER_POLICY_CHANGED");
  if (evidence.provider.runtimeVersion !== current.provider.runtimeVersion || evidence.provider.runtimeArtifactDigest !== current.provider.runtimeArtifactDigest) reasons.push("PROVIDER_RUNTIME_CHANGED");
  if (JSON.stringify([...evidence.provider.capabilities].sort()) !== JSON.stringify([...current.provider.capabilities].sort())) reasons.push("PROVIDER_RUNTIME_CHANGED");
  if (Date.parse(evidence.validUntil) <= now.getTime()) reasons.push("ACTIVATION_EVIDENCE_EXPIRED");
  return sortedReasons(reasons);
}

/**
 * Activate preflight when the shared observation cannot produce a full
 * reconcile: a definite locally-observable provider difference supersedes the
 * coarser observation refusal with its precise code, and the evidence window is
 * enforced even then. Everything stays fail-closed — an unobservable input
 * keeps the observation's refusal.
 */
export function activationPreflightRefusals(
  evidence: ActivationEvidencePayload,
  provider: ProviderInstanceRecord,
  refusalReasonCodes: readonly ActivationReasonCode[],
  now: Date,
): readonly ActivationReasonCode[] {
  const reasons: ActivationReasonCode[] = [];
  const local = providerLocalChanges(evidence.provider, provider);
  reasons.push(...(local.length ? local : refusalReasonCodes));
  if (Date.parse(evidence.validUntil) <= now.getTime()) reasons.push("ACTIVATION_EVIDENCE_EXPIRED");
  return sortedReasons(reasons);
}

/** Default binding source: managed query for the workspace's Git facts, filesystem-only for the Provider. */
export class DefaultActivationBindingSource implements ActivationBindingSource {
  private readonly observation: ActivationLoadFacts;
  private readonly privateRoots: readonly string[];
  constructor(options: Readonly<{ observation: ActivationLoadFacts; privateRoots: readonly string[] }>) {
    this.observation = options.observation;
    this.privateRoots = options.privateRoots;
  }

  async snapshot(input: { workspace: WorkspaceRecord; provider: ProviderInstanceRecord; executor: ManagedQueryPort; operationId: string }): Promise<ActivationBindingSnapshotResult> {
    if (input.workspace.state === "disabled") return refused("WORKSPACE_NOT_VERIFIED");
    if (privateDirectoryOverlap(input.workspace.canonicalRoot, this.privateRoots)) return refused("WORKSPACE_PRIVATE_DIRECTORY_OVERLAP");
    let toplevel: string;
    try {
      const top = await input.executor.readOnlyGit({ argv: workspaceArgv(input.workspace.canonicalRoot, "toplevel"), cwd: input.workspace.canonicalRoot, maxBufferBytes: QUERY_MAX_BUFFER_BYTES, timeoutMs: QUERY_TIMEOUT_MS, operationId: input.operationId });
      toplevel = top.stdout.trim();
    } catch { return refused("WORKSPACE_QUERY_UNVERIFIED"); }
    let resolvedRoot: string;
    try { resolvedRoot = canonicalPath(toplevel); } catch { return refused("WORKSPACE_CHECKOUT_UNAVAILABLE"); }
    // A recorded checkout identity must still match the observed toplevel. An
    // unknown identity — SQL-bootstrapped local rows keep worktreeRoot "" —
    // is decided by this managed query alone: never by canonicalizing the
    // empty root to the host process cwd, and never by guessing from the
    // canonical root, which may be a repository subdirectory.
    if (input.workspace.worktreeRoot && toplevel !== input.workspace.worktreeRoot) return refused("WORKSPACE_IDENTITY_CHANGED");
    if (privateDirectoryOverlap(resolvedRoot, this.privateRoots)) return refused("WORKSPACE_PRIVATE_DIRECTORY_OVERLAP");
    const record: WorkspaceRecord = input.workspace.worktreeRoot
      ? input.workspace
      : { ...input.workspace, worktreeRoot: resolvedRoot, checkoutKey: checkoutKey(resolvedRoot) };
    let commonDir: string;
    try {
      const common = await input.executor.readOnlyGit({ argv: workspaceArgv(record.worktreeRoot, "common_dir"), cwd: record.worktreeRoot, maxBufferBytes: QUERY_MAX_BUFFER_BYTES, timeoutMs: QUERY_TIMEOUT_MS, operationId: input.operationId });
      commonDir = common.stdout.trim();
    } catch { return refused("WORKSPACE_QUERY_UNVERIFIED"); }
    let common: string;
    try { common = canonicalPath(commonDir); } catch { return refused("WORKSPACE_CHECKOUT_UNAVAILABLE"); }
    if (privateDirectoryOverlap(common, this.privateRoots)) return refused("WORKSPACE_PRIVATE_DIRECTORY_OVERLAP");
    const commonDirIdentity = directoryIdentity(common);
    if (!commonDirIdentity) return refused("WORKSPACE_CHECKOUT_UNAVAILABLE");
    const observed = this.workspaceFacts(record);
    if (!observed.ready) return observed;
    const provider = this.observation.provider(input.provider);
    if (!provider.ready) return refused(...provider.reasonCodes);
    return Object.freeze({ ready: true as const, value: Object.freeze({
      workspace: Object.freeze({ ...observed.value, gitCommonDir: common, commonDirIdentity }),
      provider: provider.value,
    }) });
  }

  reconcile(input: { workspace: WorkspaceRecord; provider: ProviderInstanceRecord }): ActivationBindingReconcileResult {
    const observed = this.workspaceFacts(input.workspace);
    if (!observed.ready) return observed;
    const provider = this.observation.provider(input.provider);
    if (!provider.ready) return refused(...provider.reasonCodes);
    return Object.freeze({ ready: true as const, value: Object.freeze({ workspace: observed.value, provider: provider.value }) });
  }

  private workspaceFacts(record: WorkspaceRecord): Readonly<{ ready: true; value: LocalWorkspaceFacts }> | Readonly<{ ready: false; reasonCodes: readonly ActivationReasonCode[] }> {
    if (record.state === "disabled") return refused("WORKSPACE_NOT_VERIFIED");
    if (privateDirectoryOverlap(record.canonicalRoot, this.privateRoots) || privateDirectoryOverlap(record.worktreeRoot, this.privateRoots)) {
      return refused("WORKSPACE_PRIVATE_DIRECTORY_OVERLAP");
    }
    const observed = this.observation.workspace(record);
    if (!observed) return refused("WORKSPACE_CHECKOUT_UNAVAILABLE");
    return Object.freeze({ ready: true as const, value: observed });
  }
}

function refused(...reasonCodes: ActivationReasonCode[]): Readonly<{ ready: false; reasonCodes: readonly ActivationReasonCode[] }> {
  return Object.freeze({ ready: false as const, reasonCodes: sortedReasons(reasonCodes) });
}

/** Fixed caller prefix plus the two allowed `rev-parse` shapes the managed query runner accepts. */
export function workspaceArgv(root: string, shape: "toplevel" | "common_dir"): readonly string[] {
  const tail = shape === "toplevel" ? ["rev-parse", "--show-toplevel"] : ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  return Object.freeze(["-c", "core.fsmonitor=false", "-C", root, ...tail]);
}

export function createHostActivationService(options: HostActivationServiceOptions): HostActivationService {
  return new HostActivationService(options);
}

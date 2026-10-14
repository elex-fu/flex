import type { SessionEvent } from "@flyx/mvp-protocol";
import { RecoveryCapability } from "@flyx/mvp-protocol";
import type { HostCatalog, CatalogExecutionRuntime } from "../catalog/host-catalog.js";
import type { AppServerClient } from "../codex/app-server-client.js";
import type { CatalogGlobalService } from "../lifecycle/catalog-host-lifecycle.js";
import type { HostRecoveryRequestLifecycle } from "./host-recovery.js";
import type { DispatchContext, ProviderId } from "../provider/types.js";
import type { ResolvedSession, SessionRuntimeContext } from "./session-registry.js";
import { inspectSchema } from "../storage/migrations/schema-version.js";
import { RecoveryError, digest } from "../storage/recovery-store.js";
import type { RecoveryCommandInput } from "../storage/recovery-store.js";
import { createHostRecovery, HostRecovery } from "./host-recovery.js";
import type { HostRecoveryOptions, RecoveryResource } from "./host-recovery.js";

export type CatalogRecoveryIdentity = Readonly<{
  sessionId: string;
  workspaceId: string;
  provider: ProviderId;
  providerInstanceId: string;
  workspacePath: string;
  checkoutRoot: string;
  configurationFingerprint: string;
}>;
/** A trusted cached acceptance record. Catalog verification/version probes are not this evidence. */
export type CachedCatalogRecoveryManifest = Readonly<{
  source: "real-provider";
  state: "verified";
  evidenceId: string;
  provider: ProviderId;
  providerInstanceId: string;
  configurationFingerprint: string;
  verifiedVersions: readonly string[];
}>;
export type ExistingCatalogRecoveryReader = Readonly<{
  source: "existing-connection";
  sessionId: string;
  providerInstanceId: string;
  configurationFingerprint: string;
  runtimeVersion: string;
  client: Pick<AppServerClient, "request">;
}>;
export type CatalogRuntimeRecoveryOptions = Pick<HostRecoveryOptions,
  "resolveResource" | "checkoutRoot" | "assertCommandAuthorized" | "processInspector" | "inspectBoundary" | "inspectWorkspace" | "codexReader" | "supersedeInteractions" | "companionEvents">;
export type CatalogRecoveryOptions = {
  catalog: HostCatalog;
  /** Global admission permits original retained recovery, but rejects Host drain. */
  assertRecoveryAdmission?: () => void;
  /** Track the whole RPC, including committed runtime/resource reconciliation. */
  trackRecovery?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Read an already verified local cache; do not probe or construct a Provider here. */
  verifiedManifestForInstance?: (identity: CatalogRecoveryIdentity) => CachedCatalogRecoveryManifest | undefined;
  /** Select an actual existing connection. Absence stays unknown; no reconnect/resume/start. */
  existingCodexReader?: (identity: CatalogRecoveryIdentity, original: DispatchContext) => ExistingCatalogRecoveryReader | undefined;
  processInspector?: HostRecoveryOptions["processInspector"];
  inspectBoundary?: HostRecoveryOptions["inspectBoundary"];
  inspectWorkspace?: HostRecoveryOptions["inspectWorkspace"];
  companionEvents?: HostRecoveryOptions["companionEvents"];
  supersedeInteractions?: HostRecoveryOptions["supersedeInteractions"];
  onBlocked?: HostRecoveryOptions["onBlocked"];
  afterRecovery?: (operation: Parameters<NonNullable<HostRecoveryOptions["afterRecovery"]>>[0], evidenceId: string, recovery: HostRecovery) => void;
  onCommit?: (events: readonly SessionEvent[]) => void;
};

/** Shared by live capture and recovery. Mutable verification, version probes and residency are excluded. */
export function catalogRecoveryConfigurationFingerprint(target: ResolvedSession): string {
  const { session, providerInstance: provider, workspace } = target;
  return digest({ version: 1, providerInstanceId: provider.providerInstanceId, provider: provider.provider,
    executable: provider.executable, configuration: provider.config, policyVersion: provider.policyVersion,
    policyCapabilities: [...provider.policyCapabilities].sort(), workspaceId: session.workspaceId,
    canonicalRoot: workspace.canonicalRoot, checkoutRoot: workspace.worktreeRoot, checkoutKey: workspace.checkoutKey,
    repositoryId: workspace.repositoryId, kind: workspace.kind });
}

/** Recovery is available for persisted Sessions independently of runtime residency. */
export class CatalogRecoveryBindings {
  private readonly unloaded = new Map<string, { identity: CatalogRecoveryIdentity; recovery: HostRecovery }>();
  private readonly services = new Set<HostRecovery>();
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  private sealed = false;
  private readonly requestLifecycle: HostRecoveryRequestLifecycle = {
    assertAdmission: () => this.assertAdmission(), assertOpen: () => this.assertOpen(),
    track: (work) => this.track(work),
  };
  readonly shutdownService: CatalogGlobalService = {
    drain: (deadlineAt) => this.drain(deadlineAt), seal: () => this.seal(), close: () => this.seal(),
  };
  constructor(private readonly options: CatalogRecoveryOptions) {
    this.options.catalog.owner.assertStorePath(this.options.catalog.store.db.name);
    inspectSchema(this.options.catalog.store.db);
  }

  readonly recoveryCapabilities = (): readonly string[] => {
    try {
      const host = this.options.catalog;
      if (!this.accepting || this.sealed || !host.store.db.open || !host.ready) return [];
      host.owner.assertActive();
      if (inspectSchema(host.store.db).version < 7) return [];
      return [RecoveryCapability];
    } catch { return []; }
  };

  readonly recoveryForSession = (sessionId: string): HostRecovery | undefined => {
    if (!this.recoveryCapabilities().length) return undefined;
    const identity = this.capture(sessionId);
    const runtime = this.options.catalog.registry.loaded(sessionId) as (CatalogExecutionRuntime & { recovery?: HostRecovery }) | undefined;
    if (runtime) {
      if (!runtime.recovery || runtime.sessionId !== sessionId || runtime.store !== this.options.catalog.store
        || runtime.owner !== this.options.catalog.owner || runtime.recovery.recovery.store !== runtime.store) throw new RecoveryError("RECOVERY_RUNTIME_BINDING_INVALID");
      return this.bind(runtime.recovery);
    }
    const existing = this.unloaded.get(sessionId);
    if (existing?.identity.configurationFingerprint === identity.configurationFingerprint) return existing.recovery;
    let recovery!: HostRecovery;
    recovery = createHostRecovery({ store: this.options.catalog.store, owner: this.options.catalog.owner, sessionId,
      workspace: identity.workspacePath, provider: identity.provider, ...this.hooks(identity, true),
      onCommit: (events) => this.publish(events),
      onBlocked: (context, reason) => { this.options.catalog.owner.retain(reason); this.options.onBlocked?.(context, reason); },
      afterRecovery: (operation, evidenceId) => this.afterRecovery(identity, recovery, operation, evidenceId) });
    this.unloaded.set(sessionId, { identity, recovery });
    return this.bind(recovery);
  };

  /** Pass into the lazy runtime's Orchestrator options before its native bindings can be captured. */
  readonly runtimeRecoveryOptions = (context: SessionRuntimeContext): CatalogRuntimeRecoveryOptions => {
    this.assertOpen();
    const host = this.options.catalog;
    host.owner.assertActive();
    if (context.store !== host.store || context.owner !== host.owner || context.ownsStore !== false || context.recoverOnStart !== false
      || !context.runtimeId) throw new RecoveryError("RECOVERY_RUNTIME_BINDING_INVALID");
    const identity = this.capture(context.session.sessionId);
    if (context.session.workspaceId !== identity.workspaceId || context.providerInstance.providerInstanceId !== identity.providerInstanceId
      || context.workspace.canonicalRoot !== identity.workspacePath || context.workspace.worktreeRoot !== identity.checkoutRoot
      || catalogRecoveryConfigurationFingerprint(context) !== identity.configurationFingerprint) throw new RecoveryError("RECOVERY_RESOURCE_MISMATCH");
    return this.hooks(identity, false);
  };

  private bind(recovery: HostRecovery): HostRecovery {
    recovery.bindRequestLifecycle(this.requestLifecycle);
    this.services.add(recovery);
    return recovery;
  }
  private assertOpen(): void {
    if (this.sealed || !this.options.catalog.store.db.open) throw new RecoveryError("RECOVERY_CLOSED");
  }
  private assertAdmission(): void {
    this.assertOpen();
    if (!this.accepting) throw new RecoveryError("RECOVERY_DRAINING");
    this.options.assertRecoveryAdmission?.();
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    this.assertAdmission();
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    // Register first: a synchronous accepted-marker callback can start shutdown.
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    const execute = () => { this.assertOpen(); return work(); };
    try { (this.options.trackRecovery ? this.options.trackRecovery(execute) : execute()).then(resolve, reject); }
    catch (error) { reject(error); }
    return result;
  }
  private async drain(deadlineAt: number): Promise<boolean> {
    this.accepting = false;
    for (const service of this.services) service.beginDrain();
    if (!this.pending.size) return true;
    const remaining = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : 0;
    if (!remaining) { this.seal(); return false; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = await Promise.race([
      Promise.allSettled([...this.pending]).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!complete) this.seal();
    return complete;
  }
  private seal(): void {
    this.accepting = false; this.sealed = true;
    for (const service of this.services) service.seal();
  }

  private afterRecovery(identity: CatalogRecoveryIdentity, recovery: HostRecovery,
    operation: Parameters<NonNullable<HostRecoveryOptions["afterRecovery"]>>[0], evidenceId: string): void {
    this.assertOpen();
    if (operation.gate !== "released") return;
    const host = this.options.catalog;
    try {
      this.assertIdentity(identity);
      const proof = recovery.recovery.releaseProof(evidenceId, [`workspace:${identity.checkoutRoot}`]);
      if (!proof || !recovery.recovery.verifyReleaseProof(proof, { resourceKey: `workspace:${identity.checkoutRoot}`,
        ownerId: proof.ownerId, ownerGeneration: proof.ownerGeneration, purpose: `workspace:${operation.turnId}` })) throw new RecoveryError("RECOVERY_RELEASE_PROOF_INVALID");
      const release = this.options.afterRecovery?.(operation, evidenceId, recovery) as unknown;
      if (release && typeof release === "object" && "then" in release) throw new RecoveryError("SYNCHRONOUS_RECOVERY_CALLBACK_REQUIRED");
      this.assertIdentity(identity);
      if (host.owner.retainedReason) throw new RecoveryError("RECOVERY_OWNERSHIP_RELEASE_REQUIRED");
      if (host.registry.loaded(identity.sessionId) || host.catalog.runtimeCloseForSession(identity.sessionId)) return;
      let event: SessionEvent | undefined;
      host.store.db.transaction(() => {
        const session = host.store.getSession(identity.sessionId);
        if (session?.activeTurnId || session?.recoveryState !== "idle" || session.recoveryRevision !== operation.recoveryRevision) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
        if (host.catalog.requireSession(identity.sessionId).residency === "unloaded") return;
        host.catalog.setResidency(identity.sessionId, "unloaded");
        event = host.store.commitEvent(identity.sessionId, "session.recovery.residency.reconciled", { turnId: operation.turnId,
          operationId: operation.operationId, recoveryRevision: operation.recoveryRevision, residency: "unloaded" });
      })();
      if (event) this.publish([event]);
    } catch (error) {
      this.assertOpen();
      let marker: SessionEvent | undefined;
      host.store.db.transaction(() => {
        const changed = host.store.db.prepare(`UPDATE sessions SET recovery_state='blocked',activity_state='outcome_unknown',active_turn_id=?,
          recovery_revision=recovery_revision+1 WHERE id=? AND active_turn_id IS NULL AND recovery_revision=?`)
          .run(operation.turnId, identity.sessionId, operation.recoveryRevision);
        if (!changed.changes) return;
        host.catalog.setResidency(identity.sessionId, "blocked");
        marker = host.store.commitEvent(identity.sessionId, "session.recovery.blocked", { turnId: operation.turnId,
          ...(operation.attemptId ? { attemptId: operation.attemptId } : {}), recoveryRevision: operation.recoveryRevision + 1,
          reason: "retained_resource_release_unverified" });
      })();
      if (marker) { this.publish([marker]); host.owner.retain("retained_resource_release_unverified"); }
      throw error instanceof RecoveryError ? error : new RecoveryError("RECOVERY_RELEASE_PROOF_INVALID");
    }
  }

  private publish(events: readonly SessionEvent[]): void {
    this.assertOpen();
    this.options.catalog.registry.publishCommittedEvents(events);
    this.assertOpen();
    this.options.onCommit?.(events);
  }

  private capture(sessionId: string): CatalogRecoveryIdentity {
    const host = this.options.catalog;
    host.owner.assertActive();
    const target = host.registry.resolve(sessionId);
    const raw = host.store.getSession(sessionId);
    if (!raw || raw.provider !== target.providerInstance.provider || raw.workspacePath !== target.workspace.canonicalRoot
      || target.session.provider !== target.providerInstance.provider || target.session.providerInstanceId !== target.providerInstance.providerInstanceId
      || target.session.workspaceId !== target.workspace.workspaceId || !target.workspace.worktreeRoot || !target.workspace.checkoutKey) throw new RecoveryError("RECOVERY_RESOURCE_MISMATCH");
    return Object.freeze({ sessionId, workspaceId: target.session.workspaceId, provider: target.providerInstance.provider,
      providerInstanceId: target.providerInstance.providerInstanceId, workspacePath: target.workspace.canonicalRoot,
      checkoutRoot: target.workspace.worktreeRoot, configurationFingerprint: catalogRecoveryConfigurationFingerprint(target) });
  }

  private assertIdentity(identity: CatalogRecoveryIdentity): void {
    this.assertOpen();
    if (digest(this.capture(identity.sessionId)) !== digest(identity)) throw new RecoveryError("RECOVERY_RESOURCE_MISMATCH");
  }

  private versions(identity: CatalogRecoveryIdentity): readonly string[] {
    const manifest = this.options.verifiedManifestForInstance?.(identity);
    if (!manifest || manifest.source !== "real-provider" || manifest.state !== "verified" || typeof manifest.evidenceId !== "string" || !manifest.evidenceId.trim() || manifest.evidenceId.length > 256
      || manifest.provider !== identity.provider || manifest.providerInstanceId !== identity.providerInstanceId
      || manifest.configurationFingerprint !== identity.configurationFingerprint || !Array.isArray(manifest.verifiedVersions)
      || !manifest.verifiedVersions.length || manifest.verifiedVersions.length > 32
      || manifest.verifiedVersions.some((version) => typeof version !== "string" || !version.trim() || version !== version.trim() || version === "unknown" || version.length > 256)) return [];
    return Object.freeze([...new Set(manifest.verifiedVersions)].sort());
  }

  private hooks(identity: CatalogRecoveryIdentity, unloaded: boolean): CatalogRuntimeRecoveryOptions {
    let selected: { context: string; reader: ExistingCatalogRecoveryReader } | undefined;
    let versionsSnapshot: string | undefined;
    const resolveResource: NonNullable<HostRecoveryOptions["resolveResource"]> = (original) => {
      this.assertIdentity(identity);
      if (original.sessionId !== identity.sessionId || original.provider !== identity.provider || original.context.sessionId !== identity.sessionId) throw new RecoveryError("RECOVERY_CONTEXT_MISMATCH");
      const versions = this.versions(identity);
      versionsSnapshot = digest(versions);
      const reader = identity.provider === "codex" && versions.length ? this.options.existingCodexReader?.(identity, original.context) : undefined;
      const trusted = reader?.source === "existing-connection" && reader.sessionId === identity.sessionId
        && reader.providerInstanceId === identity.providerInstanceId && reader.configurationFingerprint === identity.configurationFingerprint
        && versions.includes(reader.runtimeVersion) && typeof reader.client?.request === "function";
      selected = trusted ? { context: digest(original.context), reader } : undefined;
      const resource: RecoveryResource = { provider: identity.provider, providerInstanceId: identity.providerInstanceId,
        workspacePath: identity.workspacePath, configurationFingerprint: identity.configurationFingerprint, verifiedVersions: versions,
        ...(trusted ? { readerVersion: reader.runtimeVersion } : {}) };
      return Object.freeze(resource);
    };
    return {
      checkoutRoot: identity.checkoutRoot,
      resolveResource,
      assertCommandAuthorized: (input: RecoveryCommandInput) => {
        this.assertIdentity(identity);
        if (input.sessionId !== identity.sessionId) throw new RecoveryError("SESSION_NOT_FOUND");
        if (versionsSnapshot && versionsSnapshot !== digest(this.versions(identity))) throw new RecoveryError("RECOVERY_EVIDENCE_STALE");
        try { this.options.catalog.assertActorSession(input.authSubjectId, identity.sessionId, "session:write"); }
        catch (error) { throw new RecoveryError(error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "FORBIDDEN"); }
      },
      codexReader: (handle) => selected?.context === digest(handle.context) ? selected.reader.client : undefined,
      inspectWorkspace: async (target) => {
        this.assertIdentity(identity);
        const state = await this.options.inspectWorkspace?.(target) ?? "unknown";
        this.assertIdentity(identity);
        // An unloaded binding cannot silently remove somebody else's retained file resources.
        return state === "clear" && unloaded && this.options.catalog.owner.retainedReason && !this.options.afterRecovery ? "unknown" : state;
      },
      ...(this.options.processInspector ? { processInspector: this.options.processInspector } : {}),
      ...(this.options.inspectBoundary ? { inspectBoundary: this.options.inspectBoundary } : {}),
      ...(this.options.companionEvents ? { companionEvents: this.options.companionEvents } : {}),
      ...(this.options.supersedeInteractions ? { supersedeInteractions: this.options.supersedeInteractions } : {}),
    };
  }
}

export function createCatalogRecoveryBindings(options: CatalogRecoveryOptions): CatalogRecoveryBindings { return new CatalogRecoveryBindings(options); }

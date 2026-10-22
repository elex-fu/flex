import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { canonicalPath } from "./host-owner.js";
import type { ProviderInstanceRecord, WorkspaceRecord } from "../storage/catalog-store.js";
import {
  activationDigest,
  type ActivationOperation, type ActivationReasonCode, type ActivationResourceKind, type ActivationResourceReadiness,
} from "../storage/activation-store.js";
import {
  compatibilityEvidenceArtifactDigest, loadTrustedCompatibilityEvidence,
  type CompatibilityEvidenceArtifact, type CompatibilityEvidenceEntry,
} from "../diagnostics/compatibility-evidence.js";

/**
 * Startup load / invalidation decision for one activated resource (design §6.3
 * step 5) and the one shared observer behind `verify`. This module is
 * deliberately read-only: it compares the recorded activation facts against
 * facts observable without a Provider, supervisor, managed query or Git
 * process, and returns typed reasons. Persisting a withdrawal is the caller's
 * explicit decision (write gate or bootstrap), so reading history never erases
 * the original recovery identities or the activation receipt.
 *
 * The binding covers exactly the LocallyObservable facts below, so verify and
 * startup load measure the same things. Git-derived observations
 * (`gitCommonDir`/`commonDirIdentity`) are audit fields of the evidence and are
 * re-proved at the next managed verify instead of being re-derived at startup.
 */

export type LocalWorkspaceFacts = Readonly<{
  canonicalRoot: string;
  worktreeRoot: string;
  checkoutKey: string;
  repositoryId: string;
  canonicalIdentity: string;
  worktreeIdentity: string;
}>;

export type WorkspaceObservation = LocalWorkspaceFacts & Readonly<{ gitCommonDir: string; commonDirIdentity: string }>;

export type ProviderObservation = Readonly<{
  providerInstanceId: string;
  provider: "claude" | "codex";
  executablePath: string;
  executableDigest: string;
  configFingerprint: string;
  policyFingerprint: string;
  runtimeVersion: string;
  runtimeArtifactDigest: string;
  capabilities: readonly string[];
}>;

export type ResourceRevisions = Readonly<{ workspace: number; provider: number }>;

export type ActivationEvidencePayload = Readonly<{
  v: 1;
  kind: "activation";
  observedAt: string;
  validUntil: string;
  /** Readiness revisions measured at verify time; the activate transaction CASes them. */
  resourceRevisions: ResourceRevisions;
  workspace: WorkspaceObservation;
  provider: ProviderObservation;
}>;

/** Installed adapter/SDK/version facts; absent components can never match recorded evidence. */
export type ProviderRuntimeFacts = Readonly<{
  providerVersion: string;
  sdkVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
}>;

/** Trusted installed supervisor contract; undefined means the backend is unavailable. */
export type SupervisionContractFacts = Readonly<{ contractId: string }>;

export type ProviderObservationDependencies = Readonly<{
  /** Host-private compatibility evidence log written by adapters/recovery inspectors. */
  compatibilityEvidencePath: string;
  supervision?: () => SupervisionContractFacts | undefined;
  runtime?: (provider: ProviderInstanceRecord) => ProviderRuntimeFacts | undefined;
  compatibilityTrust?: import("../diagnostics/compatibility-evidence.js").CompatibilityEvidenceTrust;
}>;

export type ProviderObservationResult =
  | Readonly<{ ready: true; value: ProviderObservation }>
  | Readonly<{ ready: false; reasonCodes: readonly ActivationReasonCode[] }>;

export type ActivationLoadFacts = {
  /** Workspace facts observable without Git. Undefined when the checkout cannot be measured. */
  workspace(record: WorkspaceRecord): LocalWorkspaceFacts | undefined;
  /** Provider facts observable without launching the executable. */
  provider(record: ProviderInstanceRecord): ProviderObservationResult;
};

export type ActivationLoadStore = {
  readonly available: boolean;
  recordReadiness(kind: ActivationResourceKind, id: string): number;
  recordDigests(kind: ActivationResourceKind, id: string): Readonly<{ activationOperationId?: string; bindingDigest?: string; readinessRevision: number }>;
  referencedOperation(kind: ActivationResourceKind, id: string): ActivationOperation | undefined;
  withdrawReadiness(kind: ActivationResourceKind, id: string, input: { at: string; reasonCodes: readonly ActivationReasonCode[] }): void;
};

export type ActivationLoadScan = Readonly<{ workspaces: readonly WorkspaceRecord[]; providers: readonly ProviderInstanceRecord[] }>;

/** Explicit invalidation port for the startup bootstrap; `withdraw` persists one decision. */
export type ActivationReadinessPort = Readonly<{
  readonly available: boolean;
  scan(): readonly ActivationResourceReadiness[];
  withdraw(readiness: ActivationResourceReadiness, at: string): void;
}>;

export type LocalActivationFactsOptions = Readonly<{
  privateRoots?: readonly string[];
  compatibilityEvidencePath: string;
  supervision?: () => SupervisionContractFacts | undefined;
  runtime?: (provider: ProviderInstanceRecord) => ProviderRuntimeFacts | undefined;
  compatibilityTrust?: import("../diagnostics/compatibility-evidence.js").CompatibilityEvidenceTrust;
}>;

/** The one shared fact source so verify, the write gate and startup load never diverge. */
export function localActivationFacts(options: LocalActivationFactsOptions): ActivationLoadFacts {
  const privateRoots = options.privateRoots ?? [];
  return Object.freeze({
    workspace: (record: WorkspaceRecord) => observeLocalWorkspace(record, privateRoots),
    provider: (record: ProviderInstanceRecord) => observeProvider(record, options),
  });
}

export class HostActivationLoad {
  private readonly now: () => Date;
  constructor(readonly store: ActivationLoadStore, private readonly facts: ActivationLoadFacts, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  get available(): boolean { return this.store.available; }

  workspace(record: WorkspaceRecord): ActivationResourceReadiness {
    const kind = "workspace" as const;
    const revision = this.available ? this.store.recordReadiness(kind, record.workspaceId) : 0;
    if (record.state === "disabled") return this.verdict(kind, record.workspaceId, revision, "missing", [], {});
    if (!this.available) return this.verdict(kind, record.workspaceId, revision, "uncheckable", ["ACTIVATION_SCHEMA_UNAVAILABLE"], {});
    if (record.state !== "active") return this.verdict(kind, record.workspaceId, revision, "stale", ["WORKSPACE_NOT_ACTIVATED"], {});
    const digests = this.store.recordDigests(kind, record.workspaceId);
    const referenced = this.store.referencedOperation(kind, record.workspaceId);
    if (!digests.activationOperationId || !digests.bindingDigest || !referenced) return this.verdict(kind, record.workspaceId, revision, "missing", ["WORKSPACE_NOT_ACTIVATED"], {});
    if (referenced.state === "rejected" || referenced.state === "outcome_unknown") {
      return this.verdict(kind, record.workspaceId, revision, "invalid", ["WORKSPACE_NOT_ACTIVATED", ...referenced.result?.reasonCodes ?? []], {});
    }
    if (referenced.state !== "completed") return this.verdict(kind, record.workspaceId, revision, "uncheckable", ["ACTIVATION_VERIFICATION_MISSING"], {});
    const stored = parseActivationPayload(referenced);
    if (!stored) return this.verdict(kind, record.workspaceId, revision, "invalid", ["ACTIVATION_EVIDENCE_INVALID"], {});
    const observed = this.facts.workspace(record);
    if (!observed) return this.verdict(kind, record.workspaceId, revision, "uncheckable", ["WORKSPACE_CHECKOUT_UNAVAILABLE"], {});
    const reasons: ActivationReasonCode[] = [];
    if (observed.canonicalRoot !== stored.workspace.canonicalRoot || observed.canonicalIdentity !== stored.workspace.canonicalIdentity
      || observed.worktreeRoot !== stored.workspace.worktreeRoot || observed.worktreeIdentity !== stored.workspace.worktreeIdentity) reasons.push("WORKSPACE_IDENTITY_CHANGED");
    if (observed.checkoutKey !== stored.workspace.checkoutKey) reasons.push("WORKSPACE_IDENTITY_CHANGED");
    if (observed.repositoryId !== stored.workspace.repositoryId) reasons.push("WORKSPACE_POLICY_CHANGED");
    if (reasons.length) return this.verdict(kind, record.workspaceId, revision, "invalid", reasons, {});
    if (!validWindow(stored.validUntil, this.now())) return this.verdict(kind, record.workspaceId, revision, "stale", ["ACTIVATION_EVIDENCE_EXPIRED"], {});
    return this.verdict(kind, record.workspaceId, revision, "valid", [], { evidenceId: referenced.id, validUntil: stored.validUntil });
  }

  provider(record: ProviderInstanceRecord): ActivationResourceReadiness {
    const kind = "provider" as const;
    const revision = this.available ? this.store.recordReadiness(kind, record.providerInstanceId) : 0;
    if (record.state === "disabled") return this.verdict(kind, record.providerInstanceId, revision, "missing", [], {});
    if (!this.available) return this.verdict(kind, record.providerInstanceId, revision, "uncheckable", ["ACTIVATION_SCHEMA_UNAVAILABLE"], {});
    if (record.state !== "configured") return this.verdict(kind, record.providerInstanceId, revision, "stale", ["PROVIDER_NOT_ACTIVATED"], {});
    const digests = this.store.recordDigests(kind, record.providerInstanceId);
    const referenced = this.store.referencedOperation(kind, record.providerInstanceId);
    if (!digests.activationOperationId || !digests.bindingDigest || !referenced) return this.verdict(kind, record.providerInstanceId, revision, "missing", ["PROVIDER_NOT_ACTIVATED"], {});
    if (referenced.state === "rejected" || referenced.state === "outcome_unknown") {
      return this.verdict(kind, record.providerInstanceId, revision, "invalid", ["PROVIDER_NOT_ACTIVATED", ...referenced.result?.reasonCodes ?? []], {});
    }
    if (referenced.state !== "completed") return this.verdict(kind, record.providerInstanceId, revision, "uncheckable", ["ACTIVATION_VERIFICATION_MISSING"], {});
    const stored = parseActivationPayload(referenced);
    if (!stored) return this.verdict(kind, record.providerInstanceId, revision, "invalid", ["ACTIVATION_EVIDENCE_INVALID"], {});
    // A definite local difference (executable, configuration, policy, policy
    // capabilities) is decided without the compatibility artifact: the precise
    // difference itself is the refusal reason, never a coarser evidence code.
    const local = providerLocalChanges(stored.provider, record);
    if (local.length) return this.verdict(kind, record.providerInstanceId, revision, "invalid", local, {});
    const observed = this.facts.provider(record);
    if (!observed.ready) return this.verdict(kind, record.providerInstanceId, revision, "uncheckable", observed.reasonCodes, {});
    const reasons: ActivationReasonCode[] = [];
    if (observed.value.executablePath !== stored.provider.executablePath || observed.value.executableDigest !== stored.provider.executableDigest) reasons.push("PROVIDER_EXECUTABLE_CHANGED");
    if (observed.value.configFingerprint !== stored.provider.configFingerprint) reasons.push("PROVIDER_CONFIG_CHANGED");
    if (observed.value.policyFingerprint !== stored.provider.policyFingerprint) reasons.push("PROVIDER_POLICY_CHANGED");
    if (observed.value.runtimeVersion !== stored.provider.runtimeVersion || observed.value.runtimeArtifactDigest !== stored.provider.runtimeArtifactDigest) reasons.push("PROVIDER_RUNTIME_CHANGED");
    if (canonicalList(observed.value.capabilities) !== canonicalList(stored.provider.capabilities)) reasons.push("PROVIDER_RUNTIME_CHANGED");
    if (reasons.length) return this.verdict(kind, record.providerInstanceId, revision, "invalid", reasons, {});
    if (!validWindow(stored.validUntil, this.now())) return this.verdict(kind, record.providerInstanceId, revision, "stale", ["ACTIVATION_EVIDENCE_EXPIRED"], {});
    return this.verdict(kind, record.providerInstanceId, revision, "valid", [], { evidenceId: referenced.id, validUntil: stored.validUntil });
  }

  scan(resources: ActivationLoadScan): readonly ActivationResourceReadiness[] {
    const results: ActivationResourceReadiness[] = [];
    for (const record of resources.workspaces) results.push(this.workspace(record));
    for (const record of resources.providers) results.push(this.provider(record));
    return Object.freeze(results);
  }

  /** Explicit decision: withdraw every verdict that cannot keep gating admission (CAS bump, reasons recorded). */
  invalidateDecided(resources: ActivationLoadScan): readonly ActivationResourceReadiness[] {
    if (!this.available) return Object.freeze([]);
    const decided = this.scan(resources).filter(activationWithdrawalRequired);
    const invalidated: ActivationResourceReadiness[] = [];
    for (const readiness of decided) {
      this.store.withdrawReadiness(readiness.resourceKind, readiness.resourceId, { at: this.now().toISOString(), reasonCodes: readiness.reasonCodes });
      invalidated.push(readiness);
    }
    return Object.freeze(invalidated);
  }

  private verdict(kind: ActivationResourceKind, id: string, revision: number, state: ActivationResourceReadiness["state"],
    reasonCodes: readonly ActivationReasonCode[], extra: { evidenceId?: string; validUntil?: string }): ActivationResourceReadiness {
    const reasons = Object.freeze([...new Set(reasonCodes)].sort()) as readonly ActivationReasonCode[];
    return Object.freeze({ state, ready: state === "valid", resourceKind: kind, resourceId: id, readinessRevision: revision, reasonCodes: reasons, ...extra });
  }
}

/** An explicit invalidation decision exists exactly when the verdict cannot keep admission open. */
export function activationWithdrawalRequired(readiness: ActivationResourceReadiness): boolean {
  return !readiness.ready && readiness.reasonCodes.length > 0;
}

/** Startup bootstrap port: read-only verdicts plus the one explicit withdrawal write. */
export function activationReadinessPort(load: HostActivationLoad, resources: () => ActivationLoadScan): ActivationReadinessPort {
  return Object.freeze({
    available: load.available,
    scan: () => load.scan(resources()),
    withdraw: (readiness: ActivationResourceReadiness, at: string) => {
      if (load.available) load.store.withdrawReadiness(readiness.resourceKind, readiness.resourceId, { at, reasonCodes: readiness.reasonCodes });
    },
  });
}

export function parseActivationPayload(operation: ActivationOperation): ActivationEvidencePayload | undefined {
  if ((operation.state !== "ready" && operation.state !== "completed") || operation.kind !== "activation") return undefined;
  const raw = operation.evidence?.payload;
  if (!raw || typeof raw !== "object") return undefined;
  const payload = raw as Partial<ActivationEvidencePayload>;
  if (payload.v !== 1 || payload.kind !== "activation" || typeof payload.observedAt !== "string" || !Number.isFinite(Date.parse(payload.observedAt)) ||
      typeof payload.validUntil !== "string" || !Number.isFinite(Date.parse(payload.validUntil))) return undefined;
  const revisions = payload.resourceRevisions;
  if (!revisions || !Number.isSafeInteger(revisions.workspace) || revisions.workspace < 0 || !Number.isSafeInteger(revisions.provider) || revisions.provider < 0) return undefined;
  if (!payload.workspace || !payload.provider) return undefined;
  const workspace = payload.workspace;
  const provider = payload.provider;
  if ([workspace.canonicalRoot, workspace.worktreeRoot, workspace.checkoutKey, workspace.repositoryId,
    workspace.canonicalIdentity, workspace.worktreeIdentity].some((value) => typeof value !== "string" || value.length < 1)) return undefined;
  if (typeof workspace.gitCommonDir !== "string" || typeof workspace.commonDirIdentity !== "string") return undefined;
  if ([provider.providerInstanceId, provider.executablePath, provider.executableDigest, provider.configFingerprint, provider.policyFingerprint,
    provider.runtimeVersion, provider.runtimeArtifactDigest].some((value) => typeof value !== "string" || value.length < 1)) return undefined;
  if (!/^[a-f0-9]{64}$/.test(provider.executableDigest) || !/^[a-f0-9]{64}$/.test(provider.runtimeArtifactDigest)) return undefined;
  if (provider.provider !== "claude" && provider.provider !== "codex") return undefined;
  if (!Array.isArray(provider.capabilities) || provider.capabilities.some((value) => typeof value !== "string" || value.length > 96)) return undefined;
  return payload as ActivationEvidencePayload;
}

/**
 * A binding digest covers exactly the locally-observable facts. Git-derived
 * audit fields and readiness revisions are deliberately outside it: the
 * revisions are CAS tokens, and the common-dir facts are re-proved by the next
 * managed verify instead of at startup.
 */
export function activationBindingDigest(payload: ActivationEvidencePayload): string {
  return activationDigest({
    v: payload.v, kind: payload.kind, observedAt: payload.observedAt, validUntil: payload.validUntil,
    workspace: { canonicalRoot: payload.workspace.canonicalRoot, worktreeRoot: payload.workspace.worktreeRoot, checkoutKey: payload.workspace.checkoutKey,
      repositoryId: payload.workspace.repositoryId, canonicalIdentity: payload.workspace.canonicalIdentity, worktreeIdentity: payload.workspace.worktreeIdentity },
    provider: { providerInstanceId: payload.provider.providerInstanceId, provider: payload.provider.provider, executablePath: payload.provider.executablePath,
      executableDigest: payload.provider.executableDigest, configFingerprint: payload.provider.configFingerprint, policyFingerprint: payload.provider.policyFingerprint,
      runtimeVersion: payload.provider.runtimeVersion, runtimeArtifactDigest: payload.provider.runtimeArtifactDigest, capabilities: [...payload.provider.capabilities].sort() },
  });
}

export function providerConfigurationFingerprint(record: Pick<ProviderInstanceRecord, "config" | "policyVersion">): string {
  return activationDigest({
    model: record.config.model ?? null, environment: sortedRecord(record.config.environment), sandboxRequired: record.config.sandboxRequired,
    policyVersion: record.policyVersion,
  });
}

export function providerPolicyFingerprint(record: Pick<ProviderInstanceRecord, "policyVersion" | "policyCapabilities">): string {
  return activationDigest({ policyVersion: record.policyVersion, policyCapabilities: [...record.policyCapabilities].sort() });
}

/** Locally-derivable provider facts that never need an artifact, supervisor or runtime. */
export type ProviderLocalFacts = Readonly<{
  executablePath: string;
  executableDigest: string;
  configFingerprint: string;
  policyFingerprint: string;
  capabilities: readonly string[];
}>;

export function providerLocalFacts(record: ProviderInstanceRecord): ProviderLocalFacts | undefined {
  const identity = fileIdentity(record.executable);
  if (!identity) return undefined;
  return Object.freeze({
    executablePath: record.executable, executableDigest: identity.digest,
    configFingerprint: providerConfigurationFingerprint(record), policyFingerprint: providerPolicyFingerprint(record),
    capabilities: Object.freeze([...record.policyCapabilities].sort()),
  });
}

/**
 * The precise locally-observable differences between a recorded provider
 * binding and the current record. These never depend on a compatibility
 * artifact: an executable that already changed, or configuration/policy facts
 * that already moved, are invalid regardless of what evidence remains.
 */
export function providerLocalChanges(recorded: ProviderObservation, record: ProviderInstanceRecord): readonly ActivationReasonCode[] {
  const local = providerLocalFacts(record);
  if (!local) return Object.freeze(["PROVIDER_EXECUTABLE_UNAVAILABLE"] as const);
  const reasons: ActivationReasonCode[] = [];
  if (local.executablePath !== recorded.executablePath || local.executableDigest !== recorded.executableDigest) reasons.push("PROVIDER_EXECUTABLE_CHANGED");
  if (local.configFingerprint !== recorded.configFingerprint) reasons.push("PROVIDER_CONFIG_CHANGED");
  if (local.policyFingerprint !== recorded.policyFingerprint) reasons.push("PROVIDER_POLICY_CHANGED");
  if (JSON.stringify(local.capabilities) !== JSON.stringify([...recorded.capabilities].sort())) reasons.push("PROVIDER_RUNTIME_CHANGED");
  return Object.freeze([...new Set(reasons)].sort()) as readonly ActivationReasonCode[];
}

/**
 * Filesystem/installed-facts-only provider observation. A missing executable,
 * supervisor or adapter/SDK measurement and every mismatch with the newest
 * passed compatibility artifact is a typed refusal; nothing is inferred.
 */
export function observeProvider(record: ProviderInstanceRecord, dependencies: ProviderObservationDependencies): ProviderObservationResult {
  const refuse = (...reasonCodes: ActivationReasonCode[]): ProviderObservationResult =>
    Object.freeze({ ready: false as const, reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()) as readonly ActivationReasonCode[] });
  if (record.state === "disabled") return refuse("PROVIDER_NOT_VERIFIED");
  const identity = fileIdentity(record.executable);
  if (!identity) return refuse("PROVIDER_EXECUTABLE_UNAVAILABLE");
  const supervision = dependencies.supervision?.();
  if (!supervision?.contractId) return refuse("SUPERVISION_CONTRACT_UNAVAILABLE");
  const runtime = dependencies.runtime?.(record);
  if (!runtime?.providerVersion) return refuse("PROVIDER_RUNTIME_UNAVAILABLE");
  const artifact = newestPassedArtifact(dependencies.compatibilityEvidencePath, record, dependencies.compatibilityTrust);
  if (!artifact) return refuse("PROVIDER_COMPATIBILITY_EVIDENCE_MISSING");
  const reasons: ActivationReasonCode[] = [];
  if (artifact.artifact.executablePath !== record.executable || artifact.artifact.executableDigest !== identity.digest) reasons.push("PROVIDER_EVIDENCE_CHANGED");
  if (artifact.artifact.configFingerprint !== providerConfigurationFingerprint(record)) reasons.push("PROVIDER_EVIDENCE_CHANGED");
  if (artifact.artifact.supervisionContractId !== supervision.contractId) reasons.push("PROVIDER_EVIDENCE_CHANGED");
  if (artifact.artifact.providerVersion !== runtime.providerVersion || (artifact.artifact.sdkVersion ?? undefined) !== runtime.sdkVersion ||
      (artifact.artifact.adapterId ?? undefined) !== runtime.adapterId || (artifact.artifact.adapterVersion ?? undefined) !== runtime.adapterVersion) reasons.push("PROVIDER_RUNTIME_CHANGED");
  if (reasons.length) return refuse(...reasons);
  return Object.freeze({ ready: true as const, value: Object.freeze({
    providerInstanceId: record.providerInstanceId, provider: record.provider, executablePath: record.executable, executableDigest: identity.digest,
    configFingerprint: providerConfigurationFingerprint(record), policyFingerprint: providerPolicyFingerprint(record),
    runtimeVersion: runtime.providerVersion, runtimeArtifactDigest: compatibilityEvidenceArtifactDigest(artifact.artifact),
    capabilities: Object.freeze([...record.policyCapabilities].sort()) }) });
}

/** Newest turn baseline that carries every required capability on one signed artifact, run and entry. */
export function newestPassedArtifact(path: string, provider: ProviderInstanceRecord, trust?: import("../diagnostics/compatibility-evidence.js").CompatibilityEvidenceTrust): (CompatibilityEvidenceEntry & { artifact: CompatibilityEvidenceArtifact }) | undefined {
  let entries: readonly CompatibilityEvidenceEntry[];
  try { entries = loadTrustedCompatibilityEvidence(path, undefined, trust); } catch { return undefined; }
  const matches = entries.filter((entry): entry is CompatibilityEvidenceEntry & { artifact: CompatibilityEvidenceArtifact } =>
    entry.provider === provider.provider && entry.artifact !== undefined && entry.result === "passed");
  matches.sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : 0);
  // One approval or a record from another build cannot activate general task
  // execution. Bind the baseline and each requested native capability to the
  // same signed artifact, isolated run and controlled entry.
  const required = new Set<string>(["turn"]);
  const scenarios: Readonly<Record<string, string>> = {
    interrupt: "interrupt", interactiveApprovals: "approval", structuredQuestions: "question",
    resumeConversation: "reconnect", conversationRewind: "rewind",
  };
  for (const capability of provider.policyCapabilities) if (scenarios[capability]) required.add(scenarios[capability]!);
  for (const baseline of matches.filter((entry) => entry.kind === "turn" && entry.capability === "turn").reverse()) {
    const digest = compatibilityEvidenceArtifactDigest(baseline.artifact);
    if ([...required].every((capability) => matches.some((entry) => entry.kind === capability && entry.capability === capability
      && entry.runId === baseline.runId && entry.entryDigest === baseline.entryDigest
      && compatibilityEvidenceArtifactDigest(entry.artifact) === digest))) return baseline;
  }
  return undefined;
}

function sortedRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
function canonicalList(value: readonly string[]): string { return JSON.stringify([...value].sort()); }
function validWindow(validUntil: string, now: Date): boolean {
  const parsed = Date.parse(validUntil);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

/** Filesystem-only fact helpers. They never launch a process and never write. */
export function directoryIdentity(path: string): string | undefined {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return undefined;
    const canonical = realpathSync(path);
    if (canonical !== path) return undefined;
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex");
  } catch { return undefined; }
}

export function fileIdentity(path: string): Readonly<{ digest: string; size: number }> | undefined {
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return undefined;
    const canonical = realpathSync(path);
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) return undefined;
    return Object.freeze({ digest: createHash("sha256").update(readFileSync(canonical)).digest("hex"), size: stat.size });
  } catch { return undefined; }
}

export function privateDirectoryOverlap(root: string, privateRoots: readonly string[]): boolean {
  const inside = (parent: string, child: string): boolean => {
    const suffix = relative(parent, child);
    return suffix === "" || suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
  };
  try {
    const canonical = canonicalPath(root);
    for (const privateRoot of privateRoots) {
      const other = canonicalPath(privateRoot);
      if (inside(canonical, other) || inside(other, canonical)) return true;
    }
    return false;
  } catch { return true; }
}

/** The one shared workspace observer used by verify and startup load. */
export function observeLocalWorkspace(record: WorkspaceRecord, privateRoots: readonly string[]): LocalWorkspaceFacts | undefined {
  if (record.state === "disabled" || !record.canonicalRoot || !record.worktreeRoot) return undefined;
  if (privateDirectoryOverlap(record.canonicalRoot, privateRoots) || privateDirectoryOverlap(record.worktreeRoot, privateRoots)) return undefined;
  const canonicalIdentity = directoryIdentity(record.canonicalRoot);
  const worktreeIdentity = directoryIdentity(record.worktreeRoot);
  if (!canonicalIdentity || !worktreeIdentity) return undefined;
  return Object.freeze({
    canonicalRoot: record.canonicalRoot, worktreeRoot: record.worktreeRoot, checkoutKey: record.checkoutKey, repositoryId: record.repositoryId,
    canonicalIdentity, worktreeIdentity,
  });
}

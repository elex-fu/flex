import { accessSync, constants, readFileSync, realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, join } from "node:path";
import { publicHostIdentity, HOST_IDENTITY_FILENAME } from "../identity/host-identity.js";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import type { CommandPlan, CommandRequest, ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { DispatchContext } from "../provider/types.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { SqliteStore } from "../storage/db.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { assertRestoreWriteReady } from "../operations/restore-service.js";
import { OperationsError } from "../operations/operation-files.js";
import { compatibilityEvidenceArtifactDigest, assertCompleteCompatibilityArtifact, type NativeCompatibilityArtifact, type CompatibilityEvidenceArtifact } from "./compatibility-evidence.js";
import { compatibilityDigest, verifyCompatibilityPayload, type CompatibilityHostIdentity } from "./compatibility-integrity.js";
import type { CompatibilityRunAuthorization } from "./compatibility-import.js";
import { assertControlledCompatibilityEntry, COMPATIBILITY_BASIC_PROMPT, COMPATIBILITY_SCENE_VERSION, type CompatibilityReadinessOptions } from "./compatibility-readiness.js";

declare const scenePermit: unique symbol;
declare const versionProbeAuthority: unique symbol;
export type CompatibilityScenePermit = Readonly<{ kind: "compatibility-scene-start"; [scenePermit]: true }>;
export type CompatibilityVersionProbeRequest = Readonly<{
  provider: "claude" | "codex"; executable: Readonly<{ path: string; digest: string }>;
  configFingerprint: string; runtimeDigest: string; operation: "--version";
}>;
export type CompatibilityVersionProbeAuthority = Readonly<{
  assertAuthorized(request: CompatibilityVersionProbeRequest): void;
  [versionProbeAuthority]: true;
}>;
export type CompatibilitySceneBinding = Readonly<{
  sessionId: string; workspaceId: string; canonicalRoot: string; checkoutRoot: string;
  providerInstanceId: string; provider: "claude" | "codex"; configurationFingerprint: string;
}>;
export type CompatibilitySceneStart = Readonly<{
  actorId: string; commandId: string; method: string; prompt: string; requestHash: string; sessionId: string;
}>;
export type CompatibilityScenePolicyOptions = {
  authorization: unknown;
  /** Independently pinned local destination identity, never taken from the ticket itself. */
  expectedDestination: CompatibilityHostIdentity;
  entry: CompatibilityReadinessOptions;
  store: SqliteStore; owner: HostOwnerHandle;
  currentBinding(): CompatibilitySceneBinding;
  /** Re-measure exact executable/config/runtime build facts; cached version strings are insufficient. */
  measureArtifact(): NativeCompatibilityArtifact;
  /** All ordinary C0, owner, checkout, resource policy and current device gates remain required. */
  assertBaseline(actorId: string, sessionId: string): void;
  now?: () => number;
};
export type CompatibilityVersionProbeOptions = Omit<CompatibilityScenePolicyOptions, "measureArtifact" | "assertBaseline"> & {
  /** Expected version is merely a signed candidate; this authority never attests that version. */
  measureCandidateArtifact(): NativeCompatibilityArtifact;
  /** C0, owner/restore/recovery and checkout policy for the fixed local read-only probe. */
  assertBaseline(): void;
};
const fail = (code: string): never => { throw new OperationsError(code); };
const same = (left: unknown, right: unknown) => compatibilityDigest(left) === compatibilityDigest(right);
const bytesDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function compatibilitySceneCommandIds(runId: string): readonly string[] {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(runId)) fail("COMPATIBILITY_RUN_MISMATCH");
  const prefix = compatibilityDigest({ sceneVersion: COMPATIBILITY_SCENE_VERSION, runId }).slice(0, 32);
  return Object.freeze(Array.from({ length: 10 }, (_, index) => `compat-${prefix}-${index + 1}`));
}
const within = (root: string, path: string) => { const value = relative(root, path); return !!value && value !== ".." && !value.startsWith("../") && !isAbsolute(value); };

/** Opaque local authority for exactly one signed basic scene; it grants no remote management scope. */
export class CompatibilityScenePolicy {
  private readonly permits = new WeakMap<object, CompatibilitySceneStart>();
  readonly commandIds: readonly string[];
  private readonly binding: CompatibilitySceneBinding;
  private readonly ticket: CompatibilityRunAuthorization;
  private readonly ticketDigest: string;
  private constructor(private readonly options: CompatibilityScenePolicyOptions, private readonly root: string, private readonly entryPath: string) {
    this.ticket = options.authorization as CompatibilityRunAuthorization;
    this.ticketDigest = compatibilityDigest(options.authorization);
    this.binding = Object.freeze({ ...options.currentBinding() });
    this.commandIds = compatibilitySceneCommandIds(this.ticket.runId);
  }
  static async create(options: CompatibilityScenePolicyOptions): Promise<CompatibilityScenePolicy> {
    const checked = await assertControlledCompatibilityEntry(options.entry);
    const policy = new CompatibilityScenePolicy(options, checked.root, checked.entryPath);
    policy.assertSource();
    return policy;
  }
  static async createVersionProbeAuthority(options: CompatibilityVersionProbeOptions): Promise<CompatibilityVersionProbeAuthority> {
    const checked = await assertControlledCompatibilityEntry(options.entry);
    // The internal object never escapes: candidate facts cannot mint start authority.
    const source = new CompatibilityScenePolicy({ ...options, measureArtifact: options.measureCandidateArtifact,
      assertBaseline: () => fail("COMPATIBILITY_VERSION_PROBE_ONLY") }, checked.root, checked.entryPath);
    const assertAuthorized = (request: CompatibilityVersionProbeRequest) => {
      source.assertSource(); options.assertBaseline();
      const candidate = options.measureCandidateArtifact();
      if (request.operation !== "--version" || request.provider !== options.entry.provider || request.executable.path !== candidate.executablePath
        || request.executable.digest !== candidate.executableDigest || request.configFingerprint !== candidate.configFingerprint
        || request.runtimeDigest !== candidate.runtimeDigest) fail("COMPATIBILITY_VERSION_PROBE_REJECTED");
    };
    // Validate the local source now too; no process is spawned by this factory.
    source.assertSource();
    return Object.freeze({ assertAuthorized }) as CompatibilityVersionProbeAuthority;
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private assertSource(): void {
    const { options, ticket } = this;
    assertHostOwner(options.owner); options.owner.assertStorePath(options.store.db.name); options.store.assertWriterOwner();
    if (options.owner.mode === "maintenance" || options.owner.recoveryOnly || options.owner.retainedReason) fail("COMPATIBILITY_SCENE_OWNER_INVALID");
    assertRestoreWriteReady(options.store.db);
    if (!verifyCompatibilityPayload(options.authorization, options.expectedDestination) || compatibilityDigest(options.authorization) !== this.ticketDigest
      || ticket.v !== 2 || ticket.kind !== "compatibility-run-authorization" || ticket.domain !== "destination-authorization"
      || ticket.sceneVersion !== COMPATIBILITY_SCENE_VERSION || ticket.runId !== options.entry.runId
      || !Number.isFinite(Date.parse(ticket.issuedAt)) || !Number.isFinite(Date.parse(ticket.expiresAt))
      || Date.parse(ticket.issuedAt) > this.now() + 5_000 || Date.parse(ticket.expiresAt) <= this.now()
      || Date.parse(ticket.expiresAt) - Date.parse(ticket.issuedAt) > 60 * 60_000) fail("COMPATIBILITY_AUTHORIZATION_INVALID");
    const source = publicHostIdentity(options.entry.identity);
    if (!same(ticket.sourceHost, source) || source.fingerprint === options.expectedDestination.fingerprint || source.hostId === options.expectedDestination.hostId) fail("COMPATIBILITY_SOURCE_MISMATCH");
    const mirror = options.store.getHostIdentityMirror();
    if (!mirror || mirror.hostId !== source.hostId || mirror.fingerprint !== source.fingerprint) fail("COMPATIBILITY_SOURCE_MISMATCH");
    const identityPath = join(options.entry.identityDirectory, HOST_IDENTITY_FILENAME), identityStat = lstatSync(identityPath);
    if (!identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.size > 16_384 || (identityStat.mode & 0o777) !== 0o600
      || typeof process.getuid === "function" && identityStat.uid !== process.getuid()
      || !same(JSON.parse(readFileSync(identityPath, "utf8")), options.entry.identity)) fail("COMPATIBILITY_SOURCE_MISMATCH");
    if (process.env.FLYX_TEST_CONTROLLED_ENTRY !== "1" || process.env.FLYX_COMPATIBILITY_MODE !== "isolated" || process.env.FLYX_COMPATIBILITY_REAL_ENABLED !== "1"
      || process.env[options.entry.provider === "claude" ? "RUN_REAL_CLAUDE" : "RUN_REAL_CODEX"] !== "1"
      || process.env.FLYX_COMPATIBILITY_RUN_ID !== ticket.runId || realpathSync(resolve(process.env.FLYX_COMPATIBILITY_ROOT ?? "")) !== this.root) fail("COMPATIBILITY_ENTRY_NOT_ENABLED");
    for (const path of [options.entry.databasePath, options.entry.identityDirectory, options.entry.workspace]) {
      if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !within(this.root, realpathSync(path))) fail("COMPATIBILITY_ISOLATION_REQUIRED");
    }
    if (realpathSync(options.entry.entryPath) !== this.entryPath || realpathSync(process.argv[1] ?? "") !== this.entryPath
      || bytesDigest(readFileSync(this.entryPath)) !== ticket.entryDigest || ticket.entryDigest !== process.env.FLYX_COMPATIBILITY_ENTRY_DIGEST) fail("COMPATIBILITY_BUILD_MISMATCH");
    const artifact = options.measureArtifact(); assertCompleteCompatibilityArtifact(artifact);
    if (ticket.provider !== options.entry.provider || ticket.artifactDigest !== compatibilityEvidenceArtifactDigest({ ...artifact, provider: ticket.provider } as CompatibilityEvidenceArtifact)
      || ticket.runtimeDigest !== artifact.runtimeDigest || !same(options.entry.artifact, artifact)) fail("COMPATIBILITY_SCENE_ARTIFACT_CHANGED");
    if (!artifact.executablePath || realpathSync(artifact.executablePath) !== artifact.executablePath) fail("COMPATIBILITY_SCENE_ARTIFACT_CHANGED");
    accessSync(artifact.executablePath, constants.X_OK);
    // Executable digest is measured by the artifact port and independently checked here.
    if (bytesDigest(readFileSync(artifact.executablePath)) !== artifact.executableDigest) fail("COMPATIBILITY_SCENE_ARTIFACT_CHANGED");
    if (!same(options.currentBinding(), this.binding) || this.binding.provider !== ticket.provider || realpathSync(this.binding.canonicalRoot) !== realpathSync(options.entry.workspace)
      || !within(this.root, realpathSync(this.binding.checkoutRoot))) fail("COMPATIBILITY_SCENE_BINDING_CHANGED");
    const session = options.store.getSession(this.binding.sessionId);
    if (!session || session.status !== "active" || session.workspaceId !== this.binding.workspaceId || session.workspacePath !== this.binding.canonicalRoot
      || session.provider !== this.binding.provider || session.recoveryState !== "idle") fail("COMPATIBILITY_SCENE_SESSION_UNAVAILABLE");
  }
  private assertStart(input: CompatibilitySceneStart): void {
    this.assertSource();
    if (input.method !== "session.startTurn" || input.prompt !== COMPATIBILITY_BASIC_PROMPT || input.sessionId !== this.binding.sessionId
      || !this.commandIds.includes(input.commandId) || !/^[a-f0-9]{64}$/.test(input.requestHash)) fail("COMPATIBILITY_SCENE_REQUEST_REJECTED");
    this.options.assertBaseline(input.actorId, input.sessionId);
    const actor = this.options.store.getDevice(input.actorId);
    if (!actor || actor.revokedAt || actor.expiresAt && Date.parse(actor.expiresAt) <= this.now() || !actor.scopes.includes("session:write")) fail("COMPATIBILITY_SCENE_DEVICE_REJECTED");
  }
  authorizeStart(input: CompatibilitySceneStart): CompatibilityScenePermit {
    this.assertStart(input);
    const permit = Object.freeze({ kind: "compatibility-scene-start" }) as CompatibilityScenePermit;
    this.permits.set(permit, Object.freeze({ ...input })); return permit;
  }
  private original(permit: CompatibilityScenePermit): CompatibilitySceneStart {
    const input = this.permits.get(permit); if (!input) return fail("COMPATIBILITY_SCENE_PERMIT_INVALID"); this.assertStart(input); return input;
  }
  assertResource(permit: CompatibilityScenePermit, binding: CompatibilitySceneBinding): void {
    this.original(permit); if (!same(binding, this.binding)) fail("COMPATIBILITY_SCENE_BINDING_CHANGED");
  }
  assertProvider(permit: CompatibilityScenePermit, provider: ProviderInstanceRecord): void {
    this.original(permit);
    const artifact = this.options.measureArtifact();
    if (provider.providerInstanceId !== this.binding.providerInstanceId || provider.provider !== this.binding.provider || provider.executable !== artifact.executablePath
      || !provider.policyCapabilities.includes("streamingText")) fail("COMPATIBILITY_SCENE_BINDING_CHANGED");
  }
  assertAcceptInCommit<T>(permit: CompatibilityScenePermit, input: { request: CommandRequest; plan: CommandPlan<T> }): void {
    if (!this.options.store.db.inTransaction) fail("COMPATIBILITY_SCENE_TRANSACTION_REQUIRED");
    const original = this.original(permit), { request, plan } = input;
    if (request.authSubjectId !== original.actorId || request.commandId !== original.commandId || request.method !== original.method
      || request.targetSessionId !== original.sessionId || request.requestHash !== original.requestHash || request.actorKind === "host") fail("COMPATIBILITY_SCENE_REQUEST_REJECTED");
    const intent = plan.intents?.[0], turn = plan.turns?.[0], receipt = plan.receipts?.[0];
    if (plan.intents?.length !== 1 || plan.turns?.length !== 1 || plan.receipts?.length !== 1 || !intent || !turn || !receipt
      || intent.kind !== "start_turn" || intent.actorKind !== "device" || intent.commandId !== original.commandId || intent.authSubjectId !== original.actorId
      || intent.sessionId !== original.sessionId || intent.requestHash !== original.requestHash || (intent.payload as { prompt?: unknown }).prompt !== COMPATIBILITY_BASIC_PROMPT
      || turn.prompt !== COMPATIBILITY_BASIC_PROMPT || turn.turnId !== intent.turnId || turn.attemptId !== intent.attemptId
      || receipt.commandId !== original.commandId || receipt.authSubjectId !== original.actorId || receipt.requestHash !== original.requestHash || receipt.state !== "accepted"
      || !intent.dispatchContext || intent.dispatchContext.hostOwnerId !== this.options.owner.ownerId || intent.dispatchContext.hostOwnerGeneration !== this.options.owner.generation) fail("COMPATIBILITY_SCENE_PLAN_REJECTED");
    const payload = intent.payload as Record<string, unknown>;
    if (Object.keys(payload).some((key) => !["prompt", "turnId", "resumeSessionId"].includes(key)) || payload.turnId !== turn.turnId
      || payload.resumeSessionId !== this.options.store.getSession(original.sessionId)?.providerSessionId
      || intent.dispatchContext.sessionId !== original.sessionId || intent.dispatchContext.flyxTurnId !== turn.turnId
      || intent.dispatchContext.attemptId !== turn.attemptId || intent.dispatchContext.runtimeGeneration !== turn.generation) fail("COMPATIBILITY_SCENE_PLAN_REJECTED");
    // The normal Engine atomically reserves this exact command through its receipt+intent.
    // A rolled-back plan consumes no slot, while another actor cannot reuse a slot.
    const reservations = this.options.store.db.prepare("SELECT auth_subject_id,command_id FROM execution_intents WHERE command_id IN (" + this.commandIds.map(() => "?").join(",") + ")").all(...this.commandIds) as { auth_subject_id: string; command_id: string }[];
    const count = new Set(reservations.map((row) => row.command_id)).size;
    if (reservations.some((row) => row.command_id === original.commandId) || count >= 10) fail("COMPATIBILITY_SCENE_COMMAND_CONSUMED");
    if (this.commandIds[count] !== original.commandId) fail("COMPATIBILITY_SCENE_COMMAND_ORDER_INVALID");
  }
  assertDispatch(input: { intent: ExecutionIntentRow; context: DispatchContext; phase?: "before_claim" | "before_marker" | "spawn" }): void {
    const intent = input.intent;
    const original: CompatibilitySceneStart = { actorId: intent.authSubjectId, commandId: intent.commandId, method: "session.startTurn", prompt: (intent.payload as { prompt?: string }).prompt ?? "", requestHash: intent.requestHash, sessionId: intent.sessionId };
    this.assertStart(original);
    const saved = new ExecutionStore(this.options.store).get(intent.id), receipt = this.options.store.getCommandReceipt(intent.authSubjectId, intent.commandId);
    const turn = intent.turnId ? this.options.store.getTurn(intent.turnId) : undefined;
    if (!saved || !same(saved, intent) || !receipt || receipt.method !== "session.startTurn" || receipt.requestHash !== original.requestHash || receipt.state !== "accepted"
      || saved.kind !== "start_turn" || saved.actorKind !== "device"
      || !(input.phase === "before_claim" ? ["pending", "claimed"] : input.phase === "before_marker" ? ["claimed"] : ["dispatching"]).includes(saved.state)
      || saved.state !== "pending" && (saved.claimOwnerId !== this.options.owner.ownerId || saved.claimOwnerGeneration !== this.options.owner.generation)
      || !saved.dispatchContext || !same(saved.dispatchContext, input.context) || input.context.hostOwnerId !== this.options.owner.ownerId || input.context.hostOwnerGeneration !== this.options.owner.generation
      || !turn || turn.id !== input.context.flyxTurnId || turn.attemptId !== input.context.attemptId || turn.generation !== input.context.runtimeGeneration
      || turn.commandId !== original.commandId || turn.authSubjectId !== original.actorId || turn.prompt !== COMPATIBILITY_BASIC_PROMPT
      || this.options.store.getActiveTurn(original.sessionId)?.id !== turn.id) fail("COMPATIBILITY_SCENE_DISPATCH_REJECTED");
    const duplicates = this.options.store.db.prepare("SELECT COUNT(*) AS n FROM execution_intents WHERE command_id=? AND kind='start_turn'").get(original.commandId) as { n: number };
    if (duplicates.n !== 1) fail("COMPATIBILITY_SCENE_COMMAND_CONSUMED");
  }
  /** Postcommit native evidence may arrive after the active relation is cleared. */
  assertObservation(context: DispatchContext): void {
    this.assertSource();
    const rows = this.options.store.db.prepare("SELECT id FROM execution_intents WHERE session_id=? AND turn_id=? AND attempt_id=? AND kind='start_turn'")
      .all(context.sessionId, context.flyxTurnId, context.attemptId) as { id: string }[];
    if (rows.length !== 1) fail("COMPATIBILITY_SCENE_OBSERVATION_REJECTED");
    const intent = new ExecutionStore(this.options.store).get(rows[0]!.id)!;
    this.assertStart({ actorId: intent.authSubjectId, commandId: intent.commandId, method: "session.startTurn", prompt: (intent.payload as { prompt?: string }).prompt ?? "", requestHash: intent.requestHash, sessionId: intent.sessionId });
    const receipt = this.options.store.getCommandReceipt(intent.authSubjectId, intent.commandId), turn = this.options.store.getTurn(context.flyxTurnId);
    if (!intent.dispatchContext || !same(intent.dispatchContext, context) || context.hostOwnerId !== this.options.owner.ownerId || context.hostOwnerGeneration !== this.options.owner.generation
      || !["dispatching", "acknowledged", "settled"].includes(intent.state) || !receipt || receipt.method !== "session.startTurn" || receipt.requestHash !== intent.requestHash
      || !turn || turn.attemptId !== context.attemptId || turn.generation !== context.runtimeGeneration || turn.commandId !== intent.commandId
      || turn.authSubjectId !== intent.authSubjectId || turn.prompt !== COMPATIBILITY_BASIC_PROMPT) fail("COMPATIBILITY_SCENE_OBSERVATION_REJECTED");
  }
}
export const createCompatibilityScenePolicy = CompatibilityScenePolicy.create;
export const createCompatibilityVersionProbeAuthority = CompatibilityScenePolicy.createVersionProbeAuthority;

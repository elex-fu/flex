import { randomUUID } from "node:crypto";
import { SessionNativeHandleSchema, type SessionNativeHandle } from "@flyx/mvp-protocol";
import { bindingDigest } from "./git-driver.js";
import type { NativeRevertDriver, NativeRevertPreparation, NativeRevertProof, NativeRevertRequest } from "./revert-types.js";
import { CheckpointError } from "./types.js";
import type { DispatchContext } from "../provider/types.js";

export const NATIVE_REVERT_DRIVER_VERSION = "native-revert-v1";
export type NativeRevertProvider = "codex" | "claude";
export type NativeHistoryBoundary = { v:1; provider:NativeRevertProvider; entryCount:number; lastId?:string; entriesDigest:string; sourceId:string };
export type NativeRevertHandle = {
  provider: NativeRevertProvider; providerInstanceId: string; nativeSessionId: string;
  workspaceId: string; workspacePath: string; configurationFingerprint: string; verifiedVersion: string;
  nativeTurnId?: string; nativeMessageId?: string; nativeBeforeMessageId?: string;
  historyContinuity?: "discontinuous";
  historyBoundary?: NativeHistoryBoundary;
  captureContext?: DispatchContext;
  [key: string]: unknown;
};
/** IDs and digests must come from persisted native history, never the Flyx projection.
 * Claude digests exclude remapped UUID, parentUuid and sessionId fields: SDK forkSession
 * remaps these IDs. They include role, content and all other semantic message fields. */
export type NativeRevertHistory = {
  provider: NativeRevertProvider; nativeSessionId: string; verifiedVersion: string;
  sourceId: string; entries: readonly { id: string; digest: string }[];
  quiescent: boolean; pendingRequest: boolean;
};
export type TrustedNativeRevertCapability = {
  provider: NativeRevertProvider; providerInstanceId: string; configurationFingerprint: string;
  verifiedVersion: string; evidenceId: string; driverVersion: typeof NATIVE_REVERT_DRIVER_VERSION;
  managedBoundaryVersion: string; operations: readonly ("conversation-rewind" | "new-conversation")[];
};
export type NativeRevertMutation = {
  operationId: string; requestId: string; requestDigest: string; originalHandle: NativeRevertHandle;
  command: { method: "thread/rollback"; threadId: string; numTurns: number }
    | { method: "forkSession"; sessionId: string; upToMessageId: string }
    | { method: "newConversation"; provider: NativeRevertProvider };
};
/** Receipt lookup must address this exact original helper execution. A session listing
 * or a matching transcript alone cannot identify a fork after its response is lost. */
export type NativeRevertMutationReceipt = {
  operationId: string; requestId: string; requestDigest: string; sourceId: string;
  state: "completed" | "not_dispatched" | "unknown";
  quiescent: boolean; pendingRequest: boolean; nativeHandle?: NativeRevertHandle;
};
export interface ManagedNativeRevertPort {
  readonly kind: "managed-native-revert";
  readonly boundaryVersion: string;
  supportsTransition?(provider: NativeRevertProvider, mode: NativeRevertRequest["mode"]): boolean;
  /** Actual thread/read(includeTurns:true), or a managed SDK history reader. */
  read(handle: NativeRevertHandle): Promise<NativeRevertHistory>;
  /** Managed helper only; revalidate the exact current execution permit at spawn.
   * No direct SDK subprocess or user transcript mutation. */
  execute(mutation: NativeRevertMutation): Promise<NativeRevertMutationReceipt>;
  /** Read only; must never retry rollback/fork/start. */
  query(mutation: NativeRevertMutation): Promise<NativeRevertMutationReceipt>;
}
export type NativeRevertJournalRecord = { mutation: NativeRevertMutation; receipt?: NativeRevertMutationReceipt };
export interface NativeRevertMutationJournal {
  /** Durable atomic insert-before-send, unique by BOTH operationId and requestId.
   * Reject any reused identity with different bytes, including across Host restarts.
   * Existing records never authorize another send, even after not_dispatched. */
  claim(mutation: NativeRevertMutation): Promise<"claimed" | "existing">;
  /** Also rejects either identity rebound to a different original record. */
  get(operationId: string, requestId: string): Promise<NativeRevertJournalRecord | undefined>;
  record(mutation: NativeRevertMutation, receipt: NativeRevertMutationReceipt): Promise<void>;
}
export type NativeRevertDriverOptions = {
  /** Trusted private metadata from native_handles / versioned checkpoint anchors.
   * Never enrich a public/canonical handle using client-supplied offsets. */
  resolveHandle: (binding: SessionNativeHandle, context: { role: "original" | "target"; checkpointId: string; checkpointPhase: string }) => NativeRevertHandle | undefined;
  capability: (handle: NativeRevertHandle) => TrustedNativeRevertCapability | undefined;
  port: ManagedNativeRevertPort; journal: NativeRevertMutationJournal; now?: () => Date;
};
type Boundary = {
  schema: typeof NATIVE_REVERT_DRIVER_VERSION; provider: NativeRevertProvider;
  checkpointId: string; checkpointPhase: "before" | "after" | "safety";
  originalHandle: NativeRevertHandle; targetHandle: NativeRevertHandle;
  originalSessionBinding: SessionNativeHandle; targetSessionBinding: SessionNativeHandle;
  originalEntries: NativeRevertHistory["entries"]; targetEntries: NativeRevertHistory["entries"];
  capabilityBinding: string;
};
type PrepareInput = Parameters<NativeRevertDriver["prepare"]>[0];
/** Canonical nativeHandle is projected to Catalog unchanged. Private anchor metadata
 * is persisted separately; adding it to strict SessionNativeHandle v1 is invalid. */
export type NativeHistoryRevertProof = NativeRevertProof & { nativeHistoryHandle?: NativeRevertHandle };

function handle(value: unknown): NativeRevertHandle {
  const item = value as NativeRevertHandle | undefined;
  if (!item || !["codex", "claude"].includes(item.provider) ||
    ![item.providerInstanceId, item.nativeSessionId, item.workspaceId, item.workspacePath, item.configurationFingerprint, item.verifiedVersion].every(nonempty)) {
    throw new CheckpointError("NATIVE_HANDLE_INVALID", "Native history requires an exact versioned Provider binding");
  }
  return structuredClone(item);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function equal(a: unknown, b: unknown): boolean { return bindingDigest(a) === bindingDigest(b); }
function sameScope(a: NativeRevertHandle, b: NativeRevertHandle): boolean {
  return a.provider === b.provider && a.providerInstanceId === b.providerInstanceId && a.workspaceId === b.workspaceId && a.workspacePath === b.workspacePath &&
    a.configurationFingerprint === b.configurationFingerprint && a.verifiedVersion === b.verifiedVersion;
}
function matchesBinding(metadata: NativeRevertHandle, binding: SessionNativeHandle): boolean {
  return metadata.provider === binding.provider && metadata.providerInstanceId === binding.providerInstanceId && metadata.workspaceId === binding.workspaceId && metadata.nativeSessionId === binding.nativeSessionId;
}
function targetEntries(provider: NativeRevertProvider, original: NativeRevertHistory["entries"], target: NativeRevertHandle, phase: Boundary["checkpointPhase"]): NativeRevertHistory["entries"] {
  const captured=target.historyBoundary;
  if(captured) {
    if(captured.v!==1 || captured.provider!==provider || !Number.isSafeInteger(captured.entryCount) || captured.entryCount<0 || captured.entryCount>original.length || !nonempty(captured.sourceId))throw new CheckpointError("NATIVE_BOUNDARY_UNAVAILABLE","Captured native prefix is invalid");
    const prefix=original.slice(0,captured.entryCount);
    if(bindingDigest(prefix)!==captured.entriesDigest || prefix.at(-1)?.id!==captured.lastId)throw new CheckpointError("NATIVE_BOUNDARY_UNAVAILABLE","Current native history differs from the captured checkpoint prefix");
    return prefix;
  }
  const id = provider === "codex" ? target.nativeTurnId : phase === "before" ? target.nativeBeforeMessageId : target.nativeMessageId;
  const index = original.findIndex((entry) => entry.id === id);
  if (!id || index < 0) throw new CheckpointError("NATIVE_BOUNDARY_UNAVAILABLE", "Checkpoint has no matching persisted native boundary");
  return original.slice(0, index + (provider === "codex" && phase === "before" ? 0 : 1));
}

/** This driver owns proof validation and send-once policy; the injected Host ports own
 * managed process execution, durable helper receipts and native format parsing. */
abstract class ProviderDriver implements NativeRevertDriver {
  constructor(readonly provider: NativeRevertProvider, protected readonly options: NativeRevertDriverOptions) {}
  async prepare(input: PrepareInput): Promise<NativeRevertPreparation> {
    input = structuredClone(input);
    try {
      const originalSessionBinding = SessionNativeHandleSchema.parse(input.originalHandle), targetSessionBinding = SessionNativeHandleSchema.parse(input.targetHandle);
      const original = this.resolve(originalSessionBinding, input, "original"), target = this.resolve(targetSessionBinding, input, "target");
      if (original.provider !== this.provider || !sameScope(original, target)) throw new Error("native_scope_mismatch");
      const capability = this.capability(original, input.mode);
      if (!["before", "after", "safety"].includes(input.checkpointPhase)) throw new Error("native_checkpoint_phase_unavailable");
      const history = await this.read(original);
      if (!history.quiescent || history.pendingRequest) throw new Error("native_history_not_quiescent");
      if (input.mode === "revert" && original.nativeSessionId !== target.nativeSessionId) throw new Error("native_session_mismatch");
      const entries = input.mode === "workspaceRestore" ? [] : targetEntries(this.provider, history.entries, target, input.checkpointPhase as Boundary["checkpointPhase"]);
      if (input.mode === "revert" && (this.provider === "claude" && entries.length === 0 || this.provider === "codex" && entries.length === history.entries.length)) throw new Error("native_transition_has_no_boundary_change");
      const boundary: Boundary = { schema: NATIVE_REVERT_DRIVER_VERSION, provider: this.provider, checkpointId: input.checkpointId,
        checkpointPhase: input.checkpointPhase as Boundary["checkpointPhase"], originalHandle: original, targetHandle: target, originalSessionBinding, targetSessionBinding,
        originalEntries: history.entries, targetEntries: entries, capabilityBinding: bindingDigest(capability) };
      return { supported: true, capability: { kind: input.mode === "revert" ? "conversation-rewind" : "new-conversation",
        evidenceId: capability.evidenceId, driverVersion: capability.driverVersion, verifiedVersion: capability.verifiedVersion },
        originalBinding: bindingDigest(input.originalHandle), targetBinding: bindingDigest({ checkpointId: input.checkpointId, nativeHandle: input.targetHandle, phase: input.checkpointPhase }), boundary };
    } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : "native_preparation_unavailable" }; }
  }
  async apply(request: NativeRevertRequest): Promise<NativeRevertProof> {
    request = structuredClone(request);
    const { boundary, mutation } = this.validate(request);
    // Existing requests are inspection-only. Perform potentially slow native reads
    // BEFORE claiming: a read that outlives the Service deadline must never leave
    // a late continuation able to send against its now-blocked operation.
    if (await this.options.journal.get(request.operationId, request.requestId)) return this.query(request);
    const before = await this.read(boundary.originalHandle);
    if (!before.quiescent || before.pendingRequest || !equal(before.entries, boundary.originalEntries)) return this.proof(request, "unknown", before.sourceId, false, before.pendingRequest);
    this.validate(request);
    // Service-owned claim rechecks the active exact operation/attempt/lease/actor
    // at the commit. No awaited read occurs between that commit and execute.
    const claimed = await this.options.journal.claim(structuredClone(mutation));
    if (claimed === "existing") return this.query(request);
    try {
      const receipt = await this.options.port.execute(structuredClone(mutation));
      this.checkReceipt(mutation, receipt);
      await this.options.journal.record(structuredClone(mutation), structuredClone(receipt));
    } catch {
      // No retry: the helper may have applied the native side effect.
      return this.query(request);
    }
    return this.query(request);
  }
  async query(request: NativeRevertRequest): Promise<NativeRevertProof> {
    request = structuredClone(request);
    const { boundary, mutation } = this.validate(request);
    const record = await this.options.journal.get(request.operationId, request.requestId);
    if (!record) return this.proof(request, "unknown", "no_original_dispatch", false, false);
    if (!equal(record.mutation, mutation)) throw new CheckpointError("NATIVE_REQUEST_REBOUND", "Native operation or request identity changed");
    try {
    let receipt: NativeRevertMutationReceipt;
    try { receipt = await this.options.port.query(structuredClone(mutation)); this.checkReceipt(mutation, receipt); }
    catch { return this.proof(request, "unknown", "original_helper_unavailable", false, true); }
    // A persisted exact successful helper receipt can identify the original fork;
    // an ambiguous lookup may not replace it with an unrelated fork.
    if (record.receipt?.state === "completed") {
      this.checkReceipt(mutation, record.receipt);
      if (receipt.state === "not_dispatched") return this.proof(request, "unknown", receipt.sourceId, false, false);
      if (receipt.state === "completed" && !equal(receipt.nativeHandle, record.receipt.nativeHandle)) throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH", "Original helper result changed");
      if (receipt.state === "unknown" && receipt.quiescent && !receipt.pendingRequest) receipt = { ...record.receipt, quiescent: true, pendingRequest: false, sourceId: receipt.sourceId };
    }
    if (!receipt.quiescent || receipt.pendingRequest) return this.proof(request, "unknown", receipt.sourceId, false, receipt.pendingRequest);
    if (receipt.state === "not_dispatched") {
      const original = await this.read(boundary.originalHandle);
      return this.proof(request, equal(original.entries, boundary.originalEntries) && original.quiescent && !original.pendingRequest ? "not_applied" : "unknown", original.sourceId, original.quiescent, original.pendingRequest);
    }
    if (request.mode === "workspaceRestore" || this.provider === "claude") {
      if (receipt.state !== "completed" || !receipt.nativeHandle) return this.proof(request, "unknown", receipt.sourceId, true, false);
      const next = handle(receipt.nativeHandle);
      if (!sameScope(boundary.originalHandle, next) || next.nativeSessionId === boundary.originalHandle.nativeSessionId) throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH", "Fork/new conversation did not create a separate native session");
      const history = await this.read(next);
      const expected = request.mode === "workspaceRestore" ? [] : boundary.targetEntries.map((entry) => entry.digest);
      const actual = request.mode === "workspaceRestore" ? history.entries : history.entries.map((entry) => entry.digest);
      // Original conversation must still exist and be unchanged after Claude fork.
      const original = await this.read(boundary.originalHandle);
      if (!history.quiescent || history.pendingRequest || !equal(actual, expected) || original && (!original.quiescent || original.pendingRequest || !equal(original.entries, boundary.originalEntries))) return this.proof(request, "unknown", history.sourceId, false, history.pendingRequest || Boolean(original?.pendingRequest));
      // The fork's UUIDs are new. Never persist the old message/Turn anchors on
      // the new native binding, even when the helper copied its input handle.
      delete next.nativeTurnId; delete next.nativeMessageId; delete next.nativeBeforeMessageId;
      if (request.mode === "workspaceRestore") next.historyContinuity = "discontinuous";
      else {
        const last = history.entries.at(-1), previous = history.entries.at(-2);
        if (last) next.nativeMessageId = last.id;
        if (previous) next.nativeBeforeMessageId = previous.id;
      }
      next.historyBoundary={v:1,provider:this.provider,entryCount:history.entries.length,entriesDigest:bindingDigest(history.entries),sourceId:history.sourceId,...(history.entries.at(-1)?{lastId:history.entries.at(-1)!.id}:{})};
      return this.proof(request, "applied", history.sourceId, true, false, next);
    }
    // Codex rollback can be proved after response loss by an exact persisted prefix
    // plus the original helper's stopped/no-pending evidence. Never roll back twice.
    const history = await this.read(boundary.originalHandle);
    if (!history.quiescent || history.pendingRequest || !equal(history.entries, boundary.targetEntries)) return this.proof(request, "unknown", history.sourceId, history.quiescent, history.pendingRequest);
    const next = { ...boundary.originalHandle };
    delete next.nativeMessageId; delete next.nativeBeforeMessageId;
    const last = boundary.targetEntries.at(-1);
    if (last) next.nativeTurnId = last.id; else delete next.nativeTurnId;
    next.historyBoundary={v:1,provider:this.provider,entryCount:history.entries.length,entriesDigest:bindingDigest(history.entries),sourceId:history.sourceId,...(last?{lastId:last.id}:{})};
    return this.proof(request, "applied", history.sourceId, true, false, next);
    } catch {
      return this.proof(request, "unknown", "native_evidence_unavailable", false, true);
    }
  }
  private capability(original: NativeRevertHandle, mode: NativeRevertRequest["mode"]): TrustedNativeRevertCapability {
    const capability = this.options.capability(original), kind = mode === "revert" ? "conversation-rewind" : "new-conversation";
    if (!capability || capability.provider !== this.provider || capability.providerInstanceId !== original.providerInstanceId || capability.configurationFingerprint !== original.configurationFingerprint ||
      capability.verifiedVersion !== original.verifiedVersion || capability.driverVersion !== NATIVE_REVERT_DRIVER_VERSION || !nonempty(capability.evidenceId) ||
      !nonempty(capability.managedBoundaryVersion) || this.options.port.kind !== "managed-native-revert" || this.options.port.boundaryVersion !== capability.managedBoundaryVersion || !capability.operations.includes(kind) || this.options.port.supportsTransition?.(this.provider,mode)===false) {
      throw new CheckpointError("PROVIDER_CAPABILITY_UNVERIFIED", "Exact native version and managed transition capability require trusted evidence");
    }
    return capability;
  }
  private resolve(binding: SessionNativeHandle, input: PrepareInput, role: "original" | "target"): NativeRevertHandle {
    const metadata = handle(this.options.resolveHandle(binding, { role, checkpointId: input.checkpointId, checkpointPhase: input.checkpointPhase }));
    if (!matchesBinding(metadata, binding)) throw new CheckpointError("NATIVE_HANDLE_INVALID", "Private native metadata belongs to a different canonical Session binding");
    return metadata;
  }
  private async read(original: NativeRevertHandle): Promise<NativeRevertHistory> {
    const history = await this.options.port.read(structuredClone(original));
    if (history.provider !== this.provider || history.nativeSessionId !== original.nativeSessionId || history.verifiedVersion !== original.verifiedVersion || !nonempty(history.sourceId) ||
      !Array.isArray(history.entries) || history.entries.some((entry) => !nonempty(entry.id) || !nonempty(entry.digest)) || new Set(history.entries.map((entry) => entry.id)).size !== history.entries.length) {
      throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH", "Native reader returned a different or malformed persisted history");
    }
    return structuredClone(history);
  }
  private validate(request: NativeRevertRequest): { boundary: Boundary; mutation: NativeRevertMutation } {
    const boundary = request.preparation.boundary as Boundary, sessionBinding = SessionNativeHandleSchema.parse(request.originalHandle), original = handle(boundary?.originalHandle);
    const capability = this.capability(original, request.mode);
    if (!nonempty(request.operationId) || !nonempty(request.requestId) || !["revert", "workspaceRestore"].includes(request.mode) || boundary?.schema !== NATIVE_REVERT_DRIVER_VERSION || boundary.provider !== this.provider ||
      !matchesBinding(original, sessionBinding) || !matchesBinding(handle(boundary.targetHandle), SessionNativeHandleSchema.parse(boundary.targetSessionBinding)) || !sameScope(original, boundary.targetHandle) ||
      request.mode === "revert" && original.nativeSessionId !== boundary.targetHandle.nativeSessionId ||
      !equal(sessionBinding, boundary.originalSessionBinding) || request.preparation.originalBinding !== bindingDigest(sessionBinding) ||
      request.preparation.targetBinding !== bindingDigest({ checkpointId: boundary.checkpointId, nativeHandle: boundary.targetSessionBinding, phase: boundary.checkpointPhase }) ||
      boundary.capabilityBinding !== bindingDigest(capability) || !equal(request.preparation.capability, { kind: request.mode === "revert" ? "conversation-rewind" : "new-conversation", evidenceId: capability.evidenceId, driverVersion: capability.driverVersion, verifiedVersion: capability.verifiedVersion }) ||
      !equal(boundary.targetEntries, request.mode === "workspaceRestore" ? [] : targetEntries(this.provider, boundary.originalEntries, boundary.targetHandle, boundary.checkpointPhase))) {
      throw new CheckpointError("NATIVE_REQUEST_REBOUND", "Preparation is not bound to this exact native request and capability");
    }
    const command: NativeRevertMutation["command"] = request.mode === "workspaceRestore" ? { method: "newConversation", provider: this.provider } : this.provider === "codex"
      ? { method: "thread/rollback", threadId: original.nativeSessionId, numTurns: boundary.originalEntries.length - boundary.targetEntries.length }
      : { method: "forkSession", sessionId: original.nativeSessionId, upToMessageId: boundary.targetEntries.at(-1)!.id };
    if (command.method === "thread/rollback" && command.numTurns < 1) throw new CheckpointError("NATIVE_BOUNDARY_UNAVAILABLE", "Rollback must remove actual native Turns");
    return { boundary, mutation: { operationId: request.operationId, requestId: request.requestId, requestDigest: bindingDigest(request), originalHandle: original, command } };
  }
  private checkReceipt(mutation: NativeRevertMutation, receipt: NativeRevertMutationReceipt): void {
    if (receipt.operationId !== mutation.operationId || receipt.requestId !== mutation.requestId || receipt.requestDigest !== mutation.requestDigest || !nonempty(receipt.sourceId) || !["completed", "not_dispatched", "unknown"].includes(receipt.state)) throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH", "Helper receipt does not identify the original native request");
  }
  private proof(request: NativeRevertRequest, state: NativeRevertProof["state"], sourceId: string, quiescent: boolean, pendingRequest: boolean, nativeHandle?: NativeRevertHandle): NativeHistoryRevertProof {
    const canonical = nativeHandle ? SessionNativeHandleSchema.parse({ ...SessionNativeHandleSchema.parse(request.originalHandle), nativeSessionId: nativeHandle.nativeSessionId, provenance: "native" }) : undefined;
    return { state, requestId: request.requestId, originalBinding: request.preparation.originalBinding, targetBinding: request.preparation.targetBinding,
      proofId: bindingDigest({ sourceId, operationId: request.operationId, requestId: request.requestId, nonce: randomUUID() }), observedAt: (this.options.now?.() ?? new Date()).toISOString(), quiescent, pendingRequest, ...(canonical && nativeHandle ? { nativeHandle: canonical, nativeHistoryHandle: nativeHandle } : {}) };
  }
}
export class CodexNativeRevertDriver extends ProviderDriver { constructor(options: NativeRevertDriverOptions) { super("codex", options); } }
export class ClaudeNativeRevertDriver extends ProviderDriver { constructor(options: NativeRevertDriverOptions) { super("claude", options); } }
export class ProviderNativeRevertDriver implements NativeRevertDriver {
  constructor(private readonly drivers: Partial<Record<NativeRevertProvider, NativeRevertDriver>>) {}
  private driver(original: unknown): NativeRevertDriver { const driver = this.drivers[SessionNativeHandleSchema.parse(original).provider]; if (!driver) throw new CheckpointError("PROVIDER_REWIND_UNSUPPORTED", "Managed Provider transition is unavailable"); return driver; }
  async prepare(input: PrepareInput): Promise<NativeRevertPreparation> { try { return await this.driver(input.originalHandle).prepare(input); } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : "native_preparation_unavailable" }; } }
  apply(request: NativeRevertRequest): Promise<NativeRevertProof> { return this.driver(request.originalHandle).apply(request); }
  query(request: NativeRevertRequest): Promise<NativeRevertProof> { return this.driver(request.originalHandle).query(request); }
}

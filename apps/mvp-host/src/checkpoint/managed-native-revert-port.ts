import { hasValidProcessStop } from "../lifecycle/managed-process-evidence.js";
import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { StdioAppServerClient, type AppServerClient, type AppServerClientHandlers, type JsonObject } from "../codex/app-server-client.js";
import { APP_SERVER_SECURITY_ARGS, restrictedEnvironment } from "../codex/adapter.js";
import { ManagedRuntimeController, type ManagedRuntimeOptions, type PreparedNativeRuntime } from "../provider/managed-runtime.js";
import type { DispatchContext } from "../provider/types.js";
import type { ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { bindingDigest } from "./git-driver.js";
import type { ManagedNativeRevertPort, NativeRevertHandle, NativeRevertHistory, NativeRevertMutation, NativeRevertMutationJournal, NativeRevertMutationReceipt } from "./native-revert-drivers.js";
import { CheckpointError } from "./types.js";

export const MANAGED_NATIVE_REVERT_BOUNDARY_VERSION = "managed-native-revert-v1";
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
export type NativeRevertExecutionObservation = { sourceId: string; quiescent: boolean; pendingRequest: boolean };
export type ManagedNativeRevertPortOptions = {
  runtime: ManagedRuntimeOptions;
  journal: NativeRevertMutationJournal;
  /** Mutation context must be reproducible from the ORIGINAL persisted attempt,
   * including after owner restart. Read contexts are fresh managed inspections. */
  contextFor(handle: NativeRevertHandle, mutation?: NativeRevertMutation): DispatchContext;
  /** Checks exact actor/lease/owner/request gate synchronously at spawn and RPC write. */
  assertCurrent(handle: NativeRevertHandle, mutation?: NativeRevertMutation): void;
  /** Original native producers only; a queued, not-yet-invoked Turn is allowed. */
  nativeState(handle: NativeRevertHandle): { quiescent: boolean; pendingRequest: boolean };
  inspectExecution(context: DispatchContext): NativeRevertExecutionObservation | Promise<NativeRevertExecutionObservation>;
  codex: { executable: string; environment?: Readonly<Record<string, string>> };
  claude?: { helperPath?: string; nodeExecutable?: string; environment?: Readonly<Record<string, string>> };
  timeoutMs?: number;
  /** Deterministic managed-boundary seams, never a production raw spawn fallback. */
  prepareRuntime?: (context: DispatchContext) => Promise<PreparedNativeRuntime>;
  clientFactory?: (handlers: AppServerClientHandlers, runtime: PreparedNativeRuntime, beforeRequest: (method: string, params: JsonObject) => void) => AppServerClient;
};
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value)) > MAX_HISTORY_BYTES) throw new Error("NATIVE_HISTORY_BUDGET"); }
function stopped(result: ProcessStopResult): boolean { return result.stopped && result.records.length > 0 && result.records.every(hasValidProcessStop); }

export function parseCodexRevertHistory(raw: unknown, handle: NativeRevertHandle): NativeRevertHistory["entries"] {
  bounded(raw);
  if (!object(raw) || !object(raw.thread) || raw.thread.id !== handle.nativeSessionId || !Array.isArray(raw.thread.turns) || raw.thread.turns.length > 10_000) throw new Error("NATIVE_CODEX_HISTORY_INVALID");
  const ids = new Set<string>();
  return raw.thread.turns.map((turn: unknown) => {
    if (!object(turn) || !text(turn.id) || ids.has(turn.id) || !["completed", "failed", "interrupted", "cancelled"].includes(String(turn.status)) || !Array.isArray(turn.items)) throw new Error("NATIVE_CODEX_TURN_BOUNDARY_INVALID");
    ids.add(turn.id); return { id: turn.id, digest: bindingDigest(turn) };
  });
}
export function parseClaudeRevertHistory(raw: unknown, handle: NativeRevertHandle): NativeRevertHistory["entries"] {
  bounded(raw);
  if (!object(raw) || raw.schema !== 1 || raw.sessionId !== handle.nativeSessionId || !Array.isArray(raw.messages) || raw.messages.length > 10_000) throw new Error("NATIVE_CLAUDE_HISTORY_INVALID");
  const ids = new Set<string>();
  return raw.messages.map((message: unknown) => {
    if (!object(message) || !text(message.uuid) || message.session_id !== handle.nativeSessionId || ids.has(message.uuid) || !["user", "assistant", "system"].includes(String(message.type)) || !("message" in message)) throw new Error("NATIVE_CLAUDE_MESSAGE_BOUNDARY_INVALID");
    ids.add(message.uuid);
    const { uuid: _uuid, session_id: _sessionId, ...semantic } = message;
    return { id: message.uuid, digest: bindingDigest(semantic) };
  });
}

/** Real native local-history transport. No query/prompt/turn-start calls occur. */
export class HostManagedNativeRevertPort implements ManagedNativeRevertPort {
  readonly kind = "managed-native-revert" as const;
  readonly boundaryVersion = MANAGED_NATIVE_REVERT_BOUNDARY_VERSION;
  private readonly controller: ManagedRuntimeController;
  constructor(private readonly options: ManagedNativeRevertPortOptions) { this.controller = new ManagedRuntimeController(options.runtime); }
  supportsTransition(provider: "codex" | "claude", mode: "revert" | "workspaceRestore"): boolean { return provider === "codex" || mode === "revert" && Boolean(this.options.claude); }
  async read(handle: NativeRevertHandle): Promise<NativeRevertHistory> {
    const raw = await this.run(handle, undefined, handle.provider === "codex" ? "read" : "claude-read");
    const state = this.options.nativeState(handle);
    return { provider: handle.provider, nativeSessionId: handle.nativeSessionId, verifiedVersion: handle.verifiedVersion,
      sourceId: raw.sourceId, entries: handle.provider === "codex" ? parseCodexRevertHistory(raw.value, handle) : parseClaudeRevertHistory(raw.value, handle),
      quiescent: state.quiescent, pendingRequest: state.pendingRequest };
  }
  async execute(mutation: NativeRevertMutation): Promise<NativeRevertMutationReceipt> {
    mutation = structuredClone(mutation);
    const handle = mutation.originalHandle;
    if (handle.provider === "claude" && mutation.command.method !== "forkSession") throw new Error("CLAUDE_NEW_CONVERSATION_UNSUPPORTED");
    if (handle.provider === "codex" && mutation.command.method === "forkSession" || handle.provider === "claude" && !this.options.claude) throw new Error("NATIVE_MUTATION_PROVIDER_MISMATCH");
    const result = await this.run(handle, mutation, "mutate");
    let nativeHandle: NativeRevertHandle | undefined;
    if (mutation.command.method === "forkSession") {
      if (!object(result.value) || result.value.schema !== 1 || !text(result.value.sessionId) || result.value.sessionId === handle.nativeSessionId) throw new Error("NATIVE_FORK_RESULT_INVALID");
      nativeHandle = { ...handle, nativeSessionId: result.value.sessionId };
    } else if (mutation.command.method === "newConversation") {
      if (!object(result.value) || !object(result.value.thread) || !text(result.value.thread.id) || result.value.thread.id === handle.nativeSessionId) throw new Error("NATIVE_THREAD_START_RESULT_INVALID");
      nativeHandle = { ...handle, nativeSessionId: result.value.thread.id };
    }
    return { operationId: mutation.operationId, requestId: mutation.requestId, requestDigest: mutation.requestDigest,
      sourceId: result.sourceId, state: "completed", quiescent: true, pendingRequest: false, ...(nativeHandle ? { nativeHandle } : {}) };
  }
  async query(mutation: NativeRevertMutation): Promise<NativeRevertMutationReceipt> {
    mutation = structuredClone(mutation);
    const record = await this.options.journal.get(mutation.operationId, mutation.requestId);
    if (!record || bindingDigest(record.mutation) !== bindingDigest(mutation)) throw new Error("NATIVE_REQUEST_REBOUND");
    // No runtime preparation and no native RPC/SDK call in this path.
    const observation = await this.options.inspectExecution(this.context(mutation.originalHandle, mutation));
    const native = this.options.nativeState(mutation.originalHandle);
    const receipt = record.receipt;
    if (receipt?.state === "not_dispatched") return { ...receipt, sourceId: bindingDigest({ original: receipt.sourceId, observation }), quiescent: observation.quiescent, pendingRequest: observation.pendingRequest };
    return { operationId: mutation.operationId, requestId: mutation.requestId, requestDigest: mutation.requestDigest,
      sourceId: observation.sourceId, state: receipt?.state === "completed" ? "completed" : "unknown",
      quiescent: observation.quiescent && native.quiescent, pendingRequest: observation.pendingRequest || native.pendingRequest,
      ...(receipt?.nativeHandle ? { nativeHandle: receipt.nativeHandle } : {}) };
  }
  async closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> { return this.controller.closeAndWait(deadlineMs); }
  private context(handle: NativeRevertHandle, mutation?: NativeRevertMutation): DispatchContext {
    const context = structuredClone(this.options.contextFor(handle, mutation));
    if (!context.sessionId || !context.runtimeId || !context.attemptId || mutation && (context.flyxTurnId !== mutation.operationId || context.attemptId !== mutation.requestId)) throw new Error("NATIVE_REVERT_CONTEXT_INVALID");
    if(!mutation&&handle.captureContext&&bindingDigest(context)!==bindingDigest(handle.captureContext))throw new Error("NATIVE_CAPTURE_CONTEXT_REBOUND");
    return context;
  }
  private async run(handle: NativeRevertHandle, mutation: NativeRevertMutation | undefined, action: "read" | "claude-read" | "mutate"): Promise<{ value: unknown; sourceId: string }> {
    const context = this.context(handle, mutation), fixed = bindingDigest(context);
    const assert = () => { this.options.assertCurrent(handle, mutation); if (fixed !== bindingDigest(this.context(handle, mutation))) throw new Error("NATIVE_REVERT_CONTEXT_REBOUND"); };
    assert();
    const runtime = await (this.options.prepareRuntime?.(context) ?? this.controller.prepare(context));
    let client: AppServerClient | undefined, value: unknown, failure: unknown, stop: ProcessStopResult | undefined;
    try {
      assert();
      if (handle.provider === "codex") {
        const beforeRequest = (method: string) => { if (!["initialize", "thread/read", "thread/rollback", "thread/start"].includes(method) || action !== "mutate" && !["initialize", "thread/read"].includes(method)) throw new Error("NATIVE_REVERT_RPC_FORBIDDEN"); assert(); };
        const handlers: AppServerClientHandlers = { onNotification() {}, onRequest(request) { client?.respondError(request.id, -32601, "Native history helper does not accept server requests"); }, onExit() {} };
        client = this.options.clientFactory?.(handlers, runtime, beforeRequest) ?? new StdioAppServerClient({ executable: this.options.codex.executable, cwd: handle.workspacePath,
          env: restrictedEnvironment(this.options.codex.environment), args: APP_SERVER_SECURITY_ARGS, handlers, processes: runtime.registry, beforeRequest,
          spawn: (command, args, options) => { assert(); return runtime.spawn({ command, args, ...options, cwd: handle.workspacePath, env: restrictedEnvironment(this.options.codex.environment) }); } });
        await client.start(); assert();
        if (!mutation) value = await client.request("thread/read", { threadId: handle.nativeSessionId, includeTurns: true }, this.options.timeoutMs ?? 30_000);
        else if (mutation.command.method === "thread/rollback") value = await client.request("thread/rollback", { threadId: mutation.command.threadId, numTurns: mutation.command.numTurns }, this.options.timeoutMs ?? 30_000);
        else if (mutation.command.method === "newConversation") value = await client.request("thread/start", { cwd: handle.workspacePath, approvalPolicy: "never", sandbox: "read-only" }, this.options.timeoutMs ?? 30_000);
        else throw new Error("NATIVE_MUTATION_PROVIDER_MISMATCH");
      } else {
        const claude = this.options.claude;
        if (!claude) throw new Error("CLAUDE_MANAGED_HELPER_UNAVAILABLE");
        if (mutation && mutation.command.method !== "forkSession") throw new Error("CLAUDE_NEW_CONVERSATION_UNSUPPORTED");
        const request = { schema: 1, method: mutation ? "fork" : "read", sessionId: handle.nativeSessionId, dir: handle.workspacePath,
          ...(mutation?.command.method === "forkSession" ? { upToMessageId: mutation.command.upToMessageId } : {}) };
        assert();
        const child = runtime.spawn({ command: claude.nodeExecutable ?? process.execPath, args: [claude.helperPath ?? fileURLToPath(new URL("../provider/native-revert-helper.js", import.meta.url))], cwd: handle.workspacePath,
          env: restrictedEnvironment(claude.environment), stdio: ["pipe", "pipe", "pipe"] });
        if (!child.stdin || !child.stdout || !child.stderr) throw new Error("NATIVE_HELPER_STDIO_UNAVAILABLE");
        const chunks: Buffer[] = []; let bytes = 0;
        const outputEnded=new Promise<void>((resolve,reject)=>{child.stdout!.once("end",resolve);child.stdout!.once("error",reject);});
        child.stdout.on("data", (chunk: Uint8Array) => { bytes += chunk.length; if (bytes <= MAX_HISTORY_BYTES) chunks.push(Buffer.from(chunk)); });
        child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(request));
        const exit = await child.waitForExit(this.options.timeoutMs ?? 30_000);
        if (!exit || exit.code !== 0 || bytes > MAX_HISTORY_BYTES) throw new Error("NATIVE_HELPER_RESULT_UNAVAILABLE");
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([outputEnded,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("NATIVE_HELPER_OUTPUT_TIMEOUT")),this.options.timeoutMs ?? 30_000);})]);}
        finally {if(timer)clearTimeout(timer);}
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      bounded(value);
    } catch (error) { failure = error; }
    finally { try { if (client?.closeAndWait) await client.closeAndWait(this.options.timeoutMs ?? 5_000); stop = await runtime.closeAndWait(this.options.timeoutMs ?? 5_000); } catch (error) { failure ??= error; } }
    if (!stop || !stopped(stop)) {
      const record = stop?.records[0];
      throw new CheckpointError("NATIVE_HELPER_STOP_UNKNOWN", "Native history helper stop is unverified", { cause: failure,
        producerFailure: { code: "NATIVE_HELPER_STOP_UNKNOWN", state: "unknown", producerStopped: false, requestBinding: bindingDigest({ context, mutation: mutation?.requestDigest ?? null }), operation: { kind: "native-history" },
          ...(record ? { helper: { processId: record.id, ...(record.boundaryEvidence ? { launchDigest: record.boundaryEvidence.launchDigest } : {}) } } : {}) } });
    }
    if (failure) throw failure;
    return { value, sourceId: bindingDigest({ context, processIds: stop.records.map((record) => record.id), proofs: stop.records.map((record) => record.stopProof), valueDigest: bindingDigest(value) }) };
  }
}

/** Read only actual original process rows; root exit alone cannot satisfy this. */
export function inspectManagedNativeRevertExecution(db: Database.Database, context: DispatchContext): NativeRevertExecutionObservation {
  const rows = db.prepare(`SELECT p.id,p.state,p.pid,p.process_group,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json FROM managed_processes p
    LEFT JOIN managed_process_identities i ON i.process_id=p.id
    LEFT JOIN managed_process_boundaries b ON b.process_id=p.id LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id
    WHERE p.owner_id=? AND p.owner_generation=? AND p.session_id=? AND p.turn_id=? AND p.runtime_id=? AND p.runtime_generation=? AND p.attempt_id=? ORDER BY p.id`)
    .all(context.hostOwnerId, context.hostOwnerGeneration, context.sessionId, context.flyxTurnId, context.runtimeId, context.runtimeGeneration, context.attemptId) as { id: string; state: string; pid: number | null; process_group: number | null; identity_json: string | null; boundary_json: string | null; launch_digest: string | null; proof_json: string | null }[];
  const proven = rows.length > 0 && rows.every((row) => {
    if (row.state === "not_spawned") return row.pid === null;
    try { return !!row.identity_json && !!row.boundary_json && !!row.launch_digest && !!row.proof_json && hasValidProcessStop({
      state: row.state, ...(row.pid !== null ? { pid: row.pid } : {}), ...(row.process_group !== null ? { processGroup: row.process_group } : {}),
      processIdentity: JSON.parse(row.identity_json), boundaryEvidence: { proof: JSON.parse(row.boundary_json), launchDigest: row.launch_digest }, stopProof: JSON.parse(row.proof_json) });
    } catch { return false; }
  });
  return { sourceId: bindingDigest({ context, rows }), quiescent: Boolean(proven), pendingRequest: !proven };
}

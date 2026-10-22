import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AppServerClient } from "../codex/app-server-client.js";
import { inspectCodexNativeTurn } from "../codex/recovery-reader.js";
import { digest } from "../storage/recovery-store.js";
import type { NativeHandle, NativeTurnObservation, NativeInspectionExecutionEvidence } from "./native-history.js";

export type NativeHistoryManifest = Readonly<{
  source: "real-provider"; state: "verified"; evidenceId: string;
  provider: NativeHandle["provider"]; providerInstanceId: string; configurationFingerprint: string;
  verifiedVersions: readonly string[];
  /** Acceptance must explicitly cover the read-only operation and transcript format. */
  historyContract: "codex-thread-read-v1" | "claude-sdk-result-v1";
}>;
export type NativeHistoryCodexConnection = Readonly<{
  source: "existing-connection" | "inspection-helper"; managed: true;
  sessionId: string; providerInstanceId: string; configurationFingerprint: string; runtimeVersion: string;
  /** Must reject an unstarted/disconnected transport; it must never start or reconnect. */
  assertReadOnlyReady(): void;
  client: Pick<AppServerClient, "request">;
}>;
export type NativeHistoryInspectionRequest = Readonly<{
  purpose: "native-history-inspection"; allowedMethods: readonly ["thread/read"];
  handle: NativeHandle; checkoutRoot: string; deadlineAt: number; signal: AbortSignal;
}>;
export type NativeHistoryInspectionHelper = Readonly<{
  connection: NativeHistoryCodexConnection;
  /** Original supervisor launch identity; a PID or root exit is insufficient. */
  launchId: string; launchDigest: string;
  originalContextDigest: string; successorProcessRecordIds: readonly string[];
  stop(deadlineAt: number): Promise<Readonly<{
    kind: "process-tree-stopped"; launchId: string; launchDigest: string; sourceId: string; contractId: string;
  }> | undefined>;
}>;
export type ClaudeTranscriptSource = Readonly<{
  path: string; format: "claude-sdk-result-v1"; runtimeVersion: string;
  sessionId: string; providerInstanceId: string; configurationFingerprint: string;
  /** Trusted original SDK receipt anchors, never inferred from transcript text. */
  anchor: Readonly<{ contextDigest: string; resultUuid: string; resultDigest: string; interruptAcknowledged?: true }>;
}>;
export type NativeHistoryReaderFactoryOptions = {
  assertBinding(handle: NativeHandle, checkoutRoot: string): void;
  verifiedManifestForHandle(handle: NativeHandle): NativeHistoryManifest | undefined;
  existingCodexReader?(handle: NativeHandle): NativeHistoryCodexConnection | undefined;
  /** Implementations must register ownership before spawn and honor signal/deadline, including failed launch. */
  openInspectionHelper?(request: NativeHistoryInspectionRequest): Promise<NativeHistoryInspectionHelper>;
  /** Re-read the durable launch and original-linked successor inventory. */
  verifyInspectionHelper?(handle: NativeHandle, helper: NativeHistoryInspectionHelper): boolean;
  /** Verify previously saved helpers too, using immutable original launch and full-tree stop refs. */
  verifyInspectionEvidence?(handle: NativeHandle, evidence: NativeInspectionExecutionEvidence): boolean;
  claudeTranscript?(handle: NativeHandle): Promise<ClaudeTranscriptSource | undefined>;
  timeoutMs?: number;
};
const unknown = (reason: string): NativeTurnObservation => ({ state: "unknown", reason });
const hash = /^[a-f0-9]{64}$/;
async function bounded<T>(work: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("NATIVE_HISTORY_TIMEOUT")), Math.max(1, deadlineAt - Date.now()));
  })]); } finally { if (timer) clearTimeout(timer); }
}

/** Explicit recovery-only reader. There is deliberately no prompt, reconnect or resume port. */
export class NativeHistoryReaderFactory {
  constructor(private readonly options: NativeHistoryReaderFactoryOptions) {}
  verifyInspectionEvidence(handle: NativeHandle, evidence: NativeInspectionExecutionEvidence): boolean {
    return evidence.version === 1 && evidence.state === "stopped" && evidence.originalContextDigest === digest(handle.context)
      && this.options.verifyInspectionEvidence?.(handle, evidence) === true;
  }

  async inspect(handle: NativeHandle, checkoutRoot: string): Promise<NativeTurnObservation> {
    let helper: NativeHistoryInspectionHelper | undefined;
    let helperAttempted = false;
    let helperStop: { sourceId: string; contractId: string } | undefined;
    let observation: NativeTurnObservation = unknown("native_history_read_failed");
    const budget = Math.min(30_000, Math.max(1, this.options.timeoutMs ?? 15_000));
    const deadlineAt = Date.now() + budget;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      this.options.assertBinding(handle, checkoutRoot);
      const manifest = this.options.verifiedManifestForHandle(handle);
      if (!manifest || manifest.source !== "real-provider" || manifest.state !== "verified" || !manifest.evidenceId?.trim()
        || manifest.provider !== handle.provider || manifest.providerInstanceId !== handle.providerInstanceId
        || manifest.configurationFingerprint !== handle.configurationFingerprint || handle.verifiedVersion === "unknown"
        || !manifest.verifiedVersions.includes(handle.verifiedVersion)) return unknown("native_history_configuration_unverified");
      const manifestDigest = digest(manifest);
      if (handle.provider === "claude") {
        if (manifest.historyContract !== "claude-sdk-result-v1") return unknown("native_history_contract_unverified");
        const source = this.options.claudeTranscript ? await bounded(this.options.claudeTranscript(handle), deadlineAt) : undefined;
        observation = source ? await bounded(readClaudeTranscript(handle, source), deadlineAt) : unknown("native_history_reader_unavailable");
      } else {
        if (manifest.historyContract !== "codex-thread-read-v1") return unknown("native_history_contract_unverified");
        let connection = this.options.existingCodexReader?.(handle);
        if (!connection && this.options.openInspectionHelper) {
          helperAttempted = true;
          const opening = this.options.openInspectionHelper({ purpose: "native-history-inspection", allowedMethods: ["thread/read"], handle, checkoutRoot, deadlineAt, signal: controller.signal });
          // A late constructor still belongs to its original supervisor and must be stopped.
          void opening.then((late) => { if (controller.signal.aborted && !helper) void late.stop(Date.now() + budget).catch(() => {}); }, () => {});
          helper = await bounded(opening, deadlineAt);
          if (helper.originalContextDigest !== digest(handle.context) || !helper.successorProcessRecordIds.length
            || new Set(helper.successorProcessRecordIds).size !== helper.successorProcessRecordIds.length
            || !this.options.verifyInspectionHelper?.(handle, helper)) throw new Error("NATIVE_HISTORY_HELPER_LAUNCH_UNVERIFIED");
          connection = helper.connection;
        }
        if (!connection || connection.managed !== true || connection.sessionId !== handle.sessionId
          || connection.providerInstanceId !== handle.providerInstanceId || connection.configurationFingerprint !== handle.configurationFingerprint
          || !manifest.verifiedVersions.includes(connection.runtimeVersion)
          || connection.source !== (helper ? "inspection-helper" : "existing-connection")) observation = unknown("native_history_connection_binding_mismatch");
        else {
          const client: Pick<AppServerClient, "request"> = { request: (method, params, timeout) => {
            if (method !== "thread/read" || controller.signal.aborted) return Promise.reject(new Error("NATIVE_HISTORY_METHOD_DENIED"));
            connection!.assertReadOnlyReady();
            return connection!.client.request(method, params, Math.min(timeout ?? budget, Math.max(1, deadlineAt - Date.now())));
          } };
          observation = await bounded(inspectCodexNativeTurn(handle, { client, readerVersion: connection.runtimeVersion,
            verifiedVersions: manifest.verifiedVersions, timeoutMs: Math.max(1, deadlineAt - Date.now()) }), deadlineAt);
        }
      }
      this.options.assertBinding(handle, checkoutRoot);
      if (manifestDigest !== digest(this.options.verifiedManifestForHandle(handle))) observation = unknown("native_history_manifest_changed");
      if (controller.signal.aborted) observation = unknown("native_history_inspection_timeout");
    } catch { observation = unknown("native_history_read_failed"); }
    finally {
      controller.abort(); clearTimeout(timer);
      if (helper) {
        try {
          const stopDeadline = Date.now() + budget;
          const proof = await bounded(helper.stop(stopDeadline), stopDeadline);
          if (!hash.test(helper.launchDigest) || !helper.launchId || proof?.kind !== "process-tree-stopped"
            || proof.launchId !== helper.launchId || proof.launchDigest !== helper.launchDigest || !proof.sourceId || !proof.contractId
            || helper.originalContextDigest !== digest(handle.context) || !helper.successorProcessRecordIds.length
            || !this.options.verifyInspectionHelper?.(handle, helper)) {
            observation = unknown("native_history_helper_stop_unverified");
          } else helperStop = { sourceId: proof.sourceId, contractId: proof.contractId };
        } catch { observation = unknown("native_history_helper_stop_unverified"); }
      } else if (helperAttempted) observation = unknown("native_history_helper_stop_unverified");
    }
    return helperAttempted ? { ...observation, inspectionExecution: {
      version: 1, state: helperStop ? "stopped" : "unknown", originalContextDigest: digest(handle.context),
      helpers: helper ? [{ launchId: helper.launchId, launchDigest: helper.launchDigest, processRecordIds: [...helper.successorProcessRecordIds], ...(helperStop ?? {}) }] : [],
    } } : observation;
  }
}

/** Only a byte-exact original result receipt is a terminal anchor. Ordinary assistant text cannot qualify. */
export async function readClaudeTranscript(handle: NativeHandle, source: ClaudeTranscriptSource): Promise<NativeTurnObservation> {
  if (source.format !== "claude-sdk-result-v1" || source.runtimeVersion !== handle.verifiedVersion || source.sessionId !== handle.sessionId
    || source.providerInstanceId !== handle.providerInstanceId || source.configurationFingerprint !== handle.configurationFingerprint
    || source.anchor.contextDigest !== digest(handle.context) || !source.anchor.resultUuid || !hash.test(source.anchor.resultDigest)) return unknown("claude_transcript_anchor_unverified");
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || typeof process.getuid === "function" && stat.uid !== process.getuid()) return unknown("claude_transcript_file_unverified");
    const bytes = await file.readFile();
    if (bytes.length > 16 * 1024 * 1024) return unknown("claude_transcript_file_unverified");
    const records: unknown[] = bytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
    const matches = records.filter((record) => !!record && typeof record === "object" && (record as { uuid?: unknown }).uuid === source.anchor.resultUuid);
    if (matches.length !== 1) return unknown("claude_transcript_anchor_missing_or_ambiguous");
    const result = matches[0] as Record<string, unknown>;
    if (digest(result) !== source.anchor.resultDigest || result.type !== "result" || result.session_id !== handle.nativeSessionId) return unknown("claude_transcript_anchor_mismatch");
    const aborted = result.terminal_reason === "aborted_tools" || result.terminal_reason === "aborted_streaming";
    if (aborted && source.anchor.interruptAcknowledged !== true) return unknown("claude_interrupt_receipt_unverified");
    const status = aborted ? "cancelled"
      : result.subtype === "success" && result.is_error === false ? "completed"
      : ["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"].includes(String(result.subtype)) && result.is_error === true ? "failed" : undefined;
    if (!status) return unknown("claude_transcript_terminal_status_unverified");
    return { state: "terminal", nativeSessionId: handle.nativeSessionId, status,
      evidence: { kind: "native-terminal", sourceId: source.anchor.resultUuid + ":" + source.anchor.resultDigest, verifiedVersion: handle.verifiedVersion, dispatchContext: handle.context } };
  } finally { await file.close(); }
}

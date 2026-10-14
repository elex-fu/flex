import { createHash } from "node:crypto";
import type { NativeHandle, NativeTurnObservation } from "../provider/native-history.js";
import type { AppServerClient } from "./app-server-client.js";

export type CodexRecoveryReaderOptions = {
  client: Pick<AppServerClient, "request">;
  verifiedVersions: readonly string[];
  readerVersion: string;
  timeoutMs?: number;
};

/** The caller owns managed transport preparation. This helper makes no native writes. */
export async function inspectCodexNativeTurn(handle: NativeHandle, options: CodexRecoveryReaderOptions): Promise<NativeTurnObservation> {
  if (handle.provider !== "codex" || !handle.nativeTurnId) return { state: "unknown", reason: "native_turn_binding_missing" };
  if (!options.verifiedVersions.includes(handle.verifiedVersion) || handle.verifiedVersion === "unknown"
    || !options.verifiedVersions.includes(options.readerVersion) || options.readerVersion === "unknown") {
    return { state: "unknown", reason: "native_history_version_unverified" };
  }
  try {
    const response = await options.client.request("thread/read", { threadId: handle.nativeSessionId, includeTurns: true }, options.timeoutMs ?? 15_000);
    return parseCodexTurnRead(response, handle, options.readerVersion);
  } catch {
    return { state: "unknown", reason: "native_history_read_failed" };
  }
}

/** Select only the bound native Turn. Prompt equality or the latest message proves nothing. */
export function parseCodexTurnRead(response: unknown, handle: NativeHandle, readerVersion = handle.verifiedVersion): NativeTurnObservation {
  if (handle.provider !== "codex" || !handle.nativeTurnId) return { state: "unknown", reason: "native_turn_binding_missing" };
  if (!isRecord(response) || !isRecord(response.thread) || response.thread.id !== handle.nativeSessionId) {
    return { state: "unknown", reason: "native_session_binding_mismatch" };
  }
  const turns = response.thread.turns;
  if (!Array.isArray(turns) || turns.length > 10_000) return { state: "unknown", reason: "native_turn_history_invalid" };
  const matches = turns.filter((turn) => isRecord(turn) && turn.id === handle.nativeTurnId);
  if (matches.length !== 1) return { state: "unknown", reason: matches.length ? "native_turn_binding_ambiguous" : "native_turn_not_found" };
  const turn = matches[0] as Record<string, unknown>;
  if (turn.status === "inProgress") return { state: "running", nativeSessionId: handle.nativeSessionId, nativeTurnId: handle.nativeTurnId };
  const status = turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : undefined;
  if (!status) return { state: "unknown", reason: "native_terminal_status_unsupported" };
  const sourceId = createHash("sha256").update(JSON.stringify({ provider: "codex", nativeSessionId: handle.nativeSessionId,
    nativeTurnId: handle.nativeTurnId, nativeStatus: turn.status, verifiedVersion: handle.verifiedVersion, readerVersion })).digest("hex");
  const error = isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message.slice(0, 4096) : undefined;
  return { state: "terminal", nativeSessionId: handle.nativeSessionId, nativeTurnId: handle.nativeTurnId, status,
    evidence: { kind: "native-terminal", sourceId, verifiedVersion: handle.verifiedVersion }, ...(error ? { error } : {}) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

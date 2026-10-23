import { basename, isAbsolute, relative, sep } from "node:path";
import { OrchestratorError, type SessionOrchestrator } from "../session/orchestrator.js";
import { RecoveryError } from "../storage/recovery-store.js";
import { ContentError } from "../content/content-store.js";
import { FrameBudgetError } from "../content/frame-budget.js";
import { TimelineError } from "../timeline/contracts.js";
import { AccessError } from "../auth/connection-authorizer.js";

type Snapshot = ReturnType<SessionOrchestrator["publicSnapshot"]>;
type Event = ReturnType<SessionOrchestrator["timeline"]>["events"][number];
type ProviderStatus = Awaited<ReturnType<SessionOrchestrator["providerStatus"]>>;
type GitStatus = Awaited<ReturnType<SessionOrchestrator["gitStatus"]>>;
type GitDiff = Awaited<ReturnType<SessionOrchestrator["gitDiff"]>>;

const PATH_KEYS = new Set(["cwd", "path", "filePath", "file_path", "targetPath", "target_path", "workspacePath", "workspace_path", "workspace", "directory"]);
const PRIVATE_RUNTIME_KEYS = new Set(["dispatchContext", "providerSessionId", "nativeSessionId", "nativeTurnId", "nativeItemId", "terminalEvidence", "boundaryEvidence", "stopProof"]);
const PRIVATE_EVIDENCE_KINDS = new Set(["native-terminal", "native-ack", "local-delivery", "not-dispatched", "unknown", "verified-tree-stop", "managed-group-stop"]);
function privateEvidence(key: string, value: unknown): boolean {
  return key === "evidence" && !!value && typeof value === "object" && "kind" in value &&
    typeof value.kind === "string" && PRIVATE_EVIDENCE_KINDS.has(value.kind);
}

/** The identical projection is used by HTTP, Direct WS and encrypted Relay RPC. */
export function publicValue(value: unknown, workspace: string, key?: string): unknown {
  if (typeof value === "string") {
    const redacted = value.split(workspace).join(".");
    if (!key || !PATH_KEYS.has(key) || !isAbsolute(value)) return redacted;
    const rel = relative(workspace, value);
    if (!rel || rel === ".") return ".";
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "[outside workspace]";
    return rel.split(sep).join("/");
  }
  if (Array.isArray(value)) return value.map((item) => publicValue(item, workspace));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([childKey, childValue]) => !PRIVATE_RUNTIME_KEYS.has(childKey) && !privateEvidence(childKey, childValue)).map(([childKey, childValue]) => [childKey, publicValue(childValue, workspace, childKey)]));
  }
  return value;
}

export function publicSnapshot(snapshot: Snapshot, workspace: string): Snapshot {
  return publicValue(snapshot, workspace) as Snapshot;
}

export function publicEvent(event: Event, workspace: string): Event {
  return { ...event, payload: publicValue(event.payload, workspace) };
}

export function publicProviderStatus(status: ProviderStatus, workspace: string): ProviderStatus {
  return { ...status, workspace: basename(workspace), executable: isAbsolute(status.executable) ? basename(status.executable) : status.executable };
}

export function publicGitStatus(status: GitStatus, workspace: string): GitStatus {
  const result = publicValue(status, workspace) as GitStatus;
  return result.error ? { ...result, error: "Git status unavailable" } : result;
}

export function publicGitDiff(diff: GitDiff, workspace: string): GitDiff {
  const result = publicValue(diff, workspace) as GitDiff;
  return result.error ? { ...result, error: "Git diff unavailable" } : result;
}

export function toRpcError(error: unknown, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof TimelineError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof OrchestratorError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof ContentError || error instanceof FrameBudgetError) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof RecoveryError) return { code: error.code, message: error.code, retryable: error.code === "RECOVERY_EVIDENCE_STALE" };
  if (error instanceof AccessError) return { code: error.code, message: error.message, retryable: false };
  // Typed access/identity failures contain deliberately public codes; never expose raw OS/SDK messages.
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^(?:ACCESS_|DEVICE_|LEASE_|IDENTITY_|PAIRING_|SCOPE_|PROTOCOL_|HOST_IDENTITY_)/.test(error.code)) {
    return { code: error.code, message: "Host access rejected", retryable: false };
  }
  return { code: fallbackCode, message: "Host request failed", retryable: false };
}

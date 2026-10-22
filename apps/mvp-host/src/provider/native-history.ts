import type { DispatchContext, ProviderId } from "./types.js";

/** A trusted binding fact recorded when a runtime reports native identity. */
export type NativeHandle = Readonly<{
  id: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  provider: ProviderId;
  providerInstanceId: string;
  nativeSessionId: string;
  nativeTurnId?: string;
  workspacePath: string;
  configurationFingerprint: string;
  verifiedVersion: string;
  context: DispatchContext;
  revision: number;
  updatedAt: string;
}>;

export type NativeInspectionExecutionEvidence = Readonly<{
  version: 1;
  state: "stopped" | "unknown";
  originalContextDigest: string;
  helpers: readonly Readonly<{ launchId: string; launchDigest: string; processRecordIds: readonly string[]; sourceId?: string; contractId?: string }>[];
}>;
export type NativeTurnObservation = (
  | { state: "terminal"; nativeSessionId: string; nativeTurnId?: string; status: "completed" | "failed" | "cancelled";
      evidence: { kind: "native-terminal"; sourceId: string; verifiedVersion: string; dispatchContext?: DispatchContext }; error?: string }
  | { state: "running"; nativeSessionId: string; nativeTurnId: string }
  | { state: "unknown"; reason: string }) & { inspectionExecution?: NativeInspectionExecutionEvidence };

/** SDK transcripts provide message history, not an authoritative Turn boundary. */
export function inspectClaudeTranscript(_handle: NativeHandle, _messages: readonly unknown[]): NativeTurnObservation {
  return { state: "unknown", reason: "claude_transcript_has_no_native_terminal_proof" };
}

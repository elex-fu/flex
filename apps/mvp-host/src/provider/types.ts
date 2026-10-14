import { randomUUID } from "node:crypto";
import type { Bootstrap } from "@flyx/mvp-protocol";

export type ProviderId = Bootstrap["provider"];
export type ApprovalAction = "allow_once" | "deny";

export type ApprovalRequest = {
  approvalId: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  cwd: string;
  createdAt: string;
};

/** The Engine fixes this identity before any Provider preparation or call. */
export type DispatchContext = Readonly<{
  hostOwnerId: string;
  hostOwnerGeneration: number;
  sessionId: string;
  flyxTurnId: string;
  runtimeId: string;
  runtimeGeneration: number;
  attemptId: string;
}>;

type AdapterEventEnvelope = {
  /** Every Provider callback carries its immutable Engine dispatch identity. */
  dispatchContext: DispatchContext;
  /** Compatibility aliases of the Engine context, never Adapter counters. */
  generation: number;
  turnId: string;
  nativeItemId?: string;
};

export type AdapterEvent =
  (
    | {
      kind: "session_init";
      provider: ProviderId;
      providerSessionId: string;
      runtimeVersion: string;
      model: string;
      tools: string[];
    }
    | { kind: "native_binding"; nativeSessionId: string; nativeTurnId: string }
    | { kind: "assistant_delta"; itemId: string; text: string }
    | { kind: "assistant_message"; itemId: string; text: string; aborted?: boolean }
    | {
      kind: "tool_started";
      itemId: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
    | {
      kind: "tool_progress";
      itemId: string;
      toolUseId: string;
      output: string;
    }
    | {
      kind: "tool_completed";
      itemId: string;
      toolUseId: string;
      output?: string;
      error?: string;
    }
    | { kind: "approval_requested"; request: ApprovalRequest }
    | {
      kind: "approval_resolved";
      approvalId: string;
      toolUseId: string;
      action: ApprovalAction | "expired" | "aborted";
    }
    | { kind: "diagnostic"; code: string; message: string; details?: unknown }
    | {
      kind: "turn_completed";
      result: string;
      costUsd: number;
      numTurns: number;
      terminalReason?: string;
    }
    | {
      kind: "turn_failed";
      subtype: string;
      errors: string[];
      terminalReason?: string;
    }
    | { kind: "turn_cancelled"; reason: string }
  ) & AdapterEventEnvelope;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AdapterEventPayload = DistributiveOmit<AdapterEvent, keyof AdapterEventEnvelope>;

/** Snapshot caller-owned values so asynchronous callbacks keep their original fence. */
export function dispatchContextForTurn(turnId: string, context?: DispatchContext): DispatchContext {
  const value = context ?? {
    hostOwnerId: "standalone",
    hostOwnerGeneration: 1,
    sessionId: "standalone",
    flyxTurnId: turnId,
    runtimeId: `standalone:${turnId}`,
    runtimeGeneration: 1,
    attemptId: randomUUID(),
  };
  if (value.flyxTurnId !== turnId
    || ![value.hostOwnerId, value.sessionId, value.flyxTurnId, value.runtimeId, value.attemptId].every((part) => typeof part === "string" && part.length > 0)
    || !Number.isSafeInteger(value.hostOwnerGeneration) || value.hostOwnerGeneration < 1
    || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 1) {
    throw new Error("INVALID_DISPATCH_CONTEXT");
  }
  return Object.freeze({ ...value });
}

export function fenceAdapterEvent(context: DispatchContext, event: AdapterEventPayload): AdapterEvent {
  return { ...event, dispatchContext: context, generation: context.runtimeGeneration, turnId: context.flyxTurnId };
}

export type AdapterEventHandler = (event: AdapterEvent) => void;

export type AdapterStatus = {
  provider: ProviderId;
  transport: "claude-agent-sdk" | "codex-app-server" | "deterministic";
  adapterVersion: string;
  executable: string;
  runtimeVersion: string;
  workspace: string;
  sandboxRequired: true;
};

export type TurnOutcome =
  | { status: "completed"; providerSessionId: string }
  | { status: "failed"; providerSessionId?: string; error: string }
  | { status: "cancelled"; providerSessionId?: string }
  | { status: "outcome_unknown"; providerSessionId?: string; error: string };

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly workspace: string;
  status(): Promise<AdapterStatus>;
  preflight(): Promise<AdapterStatus>;
  runTurn(turnId: string, prompt: string, resumeSessionId?: string, context?: DispatchContext): Promise<TurnOutcome>;
  interrupt(reason?: string): Promise<"accepted" | "already_terminal" | "unavailable">;
  respondApproval(approvalId: string, action: ApprovalAction): boolean;
  close?(): void;
}

import { randomUUID } from "node:crypto";
import type { Bootstrap, QuestionAnswers } from "@flyx/mvp-protocol";

import type { AppServerClient } from "../codex/app-server-client.js";
import type { NativeQuestionDelivery, NativeQuestionRequest, NativeInteractionEvidence, NativeInteractionMethod } from "../interaction/types.js";

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
  /** Private native request metadata; the public projection strips this key. */
  dispatchContext?: { nativeRequestId: string; nativeMethod: NativeInteractionMethod };
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
  terminalEvidence?: ProviderEvidence;
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
    | { kind: "question_requested"; request: NativeQuestionRequest }
    | { kind: "question_resolved"; interactionId: string; status: "expired" | "superseded" | "confirmed"; evidence?: NativeInteractionEvidence }
    | { kind: "approval_requested"; request: ApprovalRequest }
    | {
      kind: "approval_resolved";
      approvalId: string;
      toolUseId: string;
      action: ApprovalAction | "expired" | "aborted";
      /**
       * Native acknowledgement of the resolution: the Provider-side promise
       * resolved by respondApproval IS the native ack (canUseTool resolution
       * for Claude, the RPC decision for Codex). Adapters attach it so the
       * interaction ingest can upgrade the row to "confirmed", which the
       * compatibility recorder requires as approval evidence. Expired and
       * aborted resolutions carry no evidence.
       */
      evidence?: NativeInteractionEvidence;
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
export type AdapterEventPayload = DistributiveOmit<AdapterEvent, Exclude<keyof AdapterEventEnvelope, "terminalEvidence">>;

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

export type ProviderEvidence =
  | { kind: "native-terminal"; sourceId: string }
  | { kind: "not-dispatched" }
  | { kind: "unknown"; reason: string };
export type ProviderAcceptance = { nativeSessionId: string; nativeTurnId?: string; sourceId: string };
export type ProviderOutcome = TurnOutcome & { evidence: ProviderEvidence };
export type ProviderRun = { accepted?: Promise<ProviderAcceptance>; outcome: Promise<ProviderOutcome> };
export type ProviderDeliveryEvidence =
  | { kind: "native-ack"; sourceId: string }
  | { kind: "local-delivery" }
  | { kind: "native-terminal"; sourceId: string }
  | { kind: "not-dispatched" }
  | { kind: "unknown"; reason: string };
export type ProviderControlOutcome = { status: "delivered" | "already_terminal" | "not_dispatched" | "outcome_unknown"; evidence: ProviderDeliveryEvidence; error?: string };

export type TurnOutcome = (
  | { status: "completed"; providerSessionId: string }
  | { status: "failed"; providerSessionId?: string; error: string }
  | { status: "cancelled"; providerSessionId?: string }
  | { status: "outcome_unknown"; providerSessionId?: string; error: string }
) & { evidence?: ProviderEvidence };

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly workspace: string;
  status(): Promise<AdapterStatus>;
  preflight(): Promise<AdapterStatus>;
  runTurn(turnId: string, prompt: string, resumeSessionId?: string, context?: DispatchContext): Promise<TurnOutcome>;
  beginTurn?(context: DispatchContext, prompt: string, resumeSessionId?: string): ProviderRun;
  deliverControl?(context: DispatchContext, command: { kind: "interrupt_turn"; reason: string } | { kind: "respond_approval"; approvalId: string; action: ApprovalAction }): Promise<ProviderControlOutcome>;
  interrupt(reason?: string): Promise<"accepted" | "already_terminal" | "unavailable">;
  respondApproval(approvalId: string, action: ApprovalAction): boolean;
  respondQuestion?(interactionId: string, answers: QuestionAnswers): NativeQuestionDelivery;
  structuredQuestionsAvailable?(): boolean;
  close?(): void;
  /** Close only this immutable Turn attempt; the adapter remains reusable for NativeHandle resume. */
  closeTurnAndWait?(context: DispatchContext, deadlineMs?: number): Promise<import("../lifecycle/managed-process-registry.js").ProcessStopResult>;
  closeAndWait?(deadlineMs?: number): Promise<import("../lifecycle/managed-process-registry.js").ProcessStopResult>;
  /** Called only after durable unknown settlement and all bounded drains. */
  sealCallbacks?(): void;
  sealProcessJournal?(): void;
  /** Read-only recovery reader over an existing native connection (Codex). Absence is unknown; it never reconnects, resumes or starts. */
  codexRecoveryReader?(context: DispatchContext): { client: Pick<AppServerClient, "request">; runtimeVersion: string } | undefined;
}

import type { SessionEvent } from "@flyx/mvp-protocol";
import type { ApprovalRow, CommandReceiptRow, CommandReceiptUpdate, EventCommitOptions, SessionRow, TurnRow } from "../storage/db.js";

export type RequestFormatVersion = 1 | 2;
export type CommandRequest = {
  authSubjectId: string;
  commandId: string;
  method: string;
  requestHash: string;
  requestFormatVersion?: RequestFormatVersion;
  targetSessionId?: string;
};
export type CommandReceiptInput = Omit<CommandReceiptRow, "createdAt" | "updatedAt">;
export type DecisionClock = { now(): string; id(): string };

export type ExecutionIntentState = "pending" | "claimed" | "dispatching" | "acknowledged" | "settled" | "outcome_unknown";
export type ExecutionIntentInput = {
  id: string;
  sessionId: string;
  turnId?: string;
  authSubjectId: string;
  commandId: string;
  ordinal: number;
  actorKind: "device" | "host";
  kind: "start_turn" | "interrupt_turn" | "respond_approval" | (string & {});
  resourceId: string;
  payload: unknown;
  requestHash: string;
  requestFormatVersion?: RequestFormatVersion;
  runtimeGeneration: number;
  attemptId: string;
  nativeRequestId?: string;
  /** Zero based event offset within this commit; defaults to its last event. */
  sourceEventOffset?: number;
};
export type ExecutionIntentRow = Omit<ExecutionIntentInput, "sourceEventOffset"> & {
  state: ExecutionIntentState;
  sourceSequence: number;
  commitId?: string;
  claimOwnerId?: string;
  claimOwnerGeneration?: number;
  resultCode?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
};
export type ExecutionIntentUpdate = {
  id: string;
  expectedStates: ExecutionIntentState[];
  state: ExecutionIntentState;
  claimOwnerId?: string;
  claimOwnerGeneration?: number;
  attemptId?: string;
  runtimeGeneration?: number;
  nativeRequestId?: string;
  resultCode?: string;
  result?: unknown;
};
export type ApprovalReservation = {
  approvalId: string;
  expectedVersion: number;
  authSubjectId: string;
  commandId: string;
  action: string;
  intentId: string;
};
export type ApprovalDeliveryState = "accepted" | "local_delivery" | "native_confirmation" | "outcome_unknown" | "aborted";
export type ApprovalDeliveryUpdate = {
  approvalId: string;
  authSubjectId: string;
  commandId: string;
  state: ApprovalDeliveryState;
};
export type ApprovalReservationRow = Omit<ApprovalReservation, "expectedVersion"> & {
  expectedVersion: number;
  state: ApprovalDeliveryState;
  createdAt: string;
  updatedAt: string;
};
export type NewTurn = {
  sessionId: string;
  turnId: string;
  authSubjectId?: string;
  commandId: string;
  requestHash: string;
  prompt: string;
  generation: number;
  attemptId?: string;
};
export type PlannedEvent = { type: string; payload: unknown; options?: EventCommitOptions; id?: string };
export type CommandFacts = {
  session?: SessionRow;
  activeTurn?: TurnRow;
  pendingApprovals: ApprovalRow[];
  approval?: ApprovalRow;
  reservation?: ApprovalReservationRow;
  runtimeGeneration: number;
  intents: ExecutionIntentRow[];
};
export type CommandPlan<T> = {
  result: T;
  expectedRevision?: number;
  events?: PlannedEvent[];
  turns?: NewTurn[];
  receipts?: CommandReceiptInput[];
  receiptUpdates?: CommandReceiptUpdate[];
  intents?: ExecutionIntentInput[];
  intentUpdates?: ExecutionIntentUpdate[];
  approvalResolutions?: Array<{ approvalId: string; expectedVersion: number; action: string }>;
  approvalReservations?: ApprovalReservation[];
  approvalDeliveries?: ApprovalDeliveryUpdate[];
};
export type CommandCommit<T> = {
  result: T;
  events: SessionEvent[];
  intents: ExecutionIntentRow[];
  sessionRevision?: number;
  commitId?: string;
  reused?: boolean;
};
export type EventCommitRow = { id: string; sessionId: string; firstSequence: number; lastSequence: number };

/** Exact v1 compatibility; v2 additionally binds the resolved target. */
export function assertReceiptRequest(receipt: CommandReceiptRow, request: CommandRequest): void {
  const format = request.requestFormatVersion ?? 1;
  if (receipt.method !== request.method || receipt.requestHash !== request.requestHash
    || (receipt.requestFormatVersion ?? 1) !== format
    || (receipt.targetSessionId !== undefined && receipt.targetSessionId !== request.targetSessionId)
    || (format === 2 && receipt.targetSessionId !== request.targetSessionId)) {
    throw new Error("COMMAND_ID_REUSED");
  }
}

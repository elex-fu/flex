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

type AdapterEventEnvelope = {
  /**
   * The adapter query generation is a fencing token.  It is deliberately
   * carried beside every event so a late SDK message can never mutate a
   * subsequent Turn after the original query has reached a terminal state.
   */
  generation?: number;
  turnId?: string;
};

export type AdapterEvent =
  (
    | {
      kind: "session_init";
      providerSessionId: string;
      claudeCodeVersion: string;
      model: string;
      tools: string[];
    }
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

export type AdapterEventHandler = (event: AdapterEvent) => void;

export type AdapterStatus = {
  sdkVersion: string;
  claudeExecutable: string;
  claudeVersion: string;
  workspace: string;
  sandboxRequired: true;
};

export type TurnOutcome =
  | { status: "completed"; providerSessionId: string }
  | { status: "failed"; providerSessionId?: string; error: string }
  | { status: "cancelled"; providerSessionId?: string }
  | { status: "outcome_unknown"; providerSessionId?: string; error: string };

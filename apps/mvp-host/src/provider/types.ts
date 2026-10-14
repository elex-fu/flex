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

type AdapterEventEnvelope = {
  /**
   * Monotonically increasing fencing token for a provider query. Late events
   * from an older query cannot mutate a newer Flyx turn.
   */
  generation?: number;
  turnId?: string;
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
  runTurn(turnId: string, prompt: string, resumeSessionId?: string): Promise<TurnOutcome>;
  interrupt(reason?: string): Promise<"accepted" | "already_terminal" | "unavailable">;
  respondApproval(approvalId: string, action: ApprovalAction): boolean;
  close?(): void;
}

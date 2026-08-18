import type {
  AdapterEvent,
  AdapterEventHandler,
  AdapterStatus,
  ApprovalAction,
  ApprovalRequest,
  TurnOutcome,
} from "../claude/types.js";

/**
 * Deterministic replacement for `ClaudeAdapter` used by browser E2E runs and
 * orchestrator integration tests.  Instead of spawning the Claude SDK it
 * replays a programmable scenario, which makes Tool calls, Approvals,
 * latency, interruptibility and failures fully controllable from a test.
 *
 * Scenario selection follows the MVP test contract: a prompt prefixed with
 * `scenario:<id>` selects the registered scenario with that id; anything
 * else selects the default `text` scenario.
 */

export type ScenarioStep =
  | { kind: "text"; text: string }
  | {
    kind: "tool";
    toolName: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    /** Emit an approval request and block the tool until it is answered. */
    approval?: boolean;
    durationMs?: number;
  }
  | { kind: "delay"; ms: number }
  | { kind: "fail"; error: string };

export type DeterministicScenario = {
  id: string;
  steps: ScenarioStep[];
  result?: string;
  costUsd?: number;
  numTurns?: number;
};

const PROVIDER_SESSION_ID = "deterministic-provider-session";

const DEFAULT_SCENARIOS: DeterministicScenario[] = [
  {
    id: "text",
    steps: [{ kind: "text", text: "deterministic reply: text scenario finished" }],
    result: "deterministic result: text scenario completed",
    costUsd: 0.01,
    numTurns: 1,
  },
  {
    id: "tool",
    steps: [
      { kind: "text", text: "running a tool without approval" },
      { kind: "tool", toolName: "Bash", input: { command: "npm test" }, output: "1 passing", durationMs: 50 },
      { kind: "text", text: "tool scenario finished" },
    ],
    result: "deterministic result: tool scenario completed",
    costUsd: 0.02,
    numTurns: 2,
  },
  {
    id: "approval",
    steps: [
      { kind: "text", text: "requesting approval before the tool runs" },
      { kind: "tool", toolName: "Bash", input: { command: "npm install" }, output: "installed", approval: true, durationMs: 50 },
      { kind: "text", text: "approval scenario finished" },
    ],
    result: "deterministic result: approval scenario completed",
    costUsd: 0.02,
    numTurns: 2,
  },
  {
    id: "slow",
    steps: [
      { kind: "delay", ms: 8_000 },
      { kind: "text", text: "slow scenario finished" },
    ],
    result: "deterministic result: slow scenario completed",
    costUsd: 0.02,
    numTurns: 1,
  },
  {
    id: "fail",
    steps: [
      { kind: "text", text: "this scenario fails on purpose" },
      { kind: "fail", error: "deterministic failure injected by the test scenario" },
    ],
    costUsd: 0.01,
    numTurns: 1,
  },
];

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type PendingDeterministicApproval = {
  request: ApprovalRequest;
  settle: (action: ApprovalAction | "aborted") => void;
};

type ActiveDeterministicTurn = {
  turnId: string;
  generation: number;
  cancelled: boolean;
  terminal: boolean;
  pending: Map<string, PendingDeterministicApproval>;
  wake: (() => void) | undefined;
};

export class DeterministicAdapter {
  readonly workspace: string;
  private readonly onEvent: AdapterEventHandler | undefined;
  private readonly scenarios = new Map<string, DeterministicScenario>();
  private active: ActiveDeterministicTurn | undefined;
  private generation = 0;

  constructor(options: { workspace: string; onEvent?: AdapterEventHandler; scenarios?: DeterministicScenario[] }) {
    this.workspace = options.workspace;
    this.onEvent = options.onEvent;
    for (const scenario of [...DEFAULT_SCENARIOS, ...(options.scenarios ?? [])]) {
      this.scenarios.set(scenario.id, scenario);
    }
  }

  registerScenario(scenario: DeterministicScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  private selectScenario(prompt: string): DeterministicScenario {
    const match = /^scenario:([a-z0-9_-]+)/i.exec(prompt.trim());
    const id = match?.[1]?.toLowerCase();
    if (id) {
      const scenario = this.scenarios.get(id);
      if (!scenario) throw new Error(`Unknown deterministic scenario: ${id}`);
      return scenario;
    }
    return this.scenarios.get("text")!;
  }

  async status(): Promise<AdapterStatus> {
    return {
      sdkVersion: "deterministic",
      claudeExecutable: "deterministic",
      claudeVersion: "deterministic",
      workspace: this.workspace,
      sandboxRequired: true,
    };
  }

  async preflight(): Promise<AdapterStatus> {
    return this.status();
  }

  async runTurn(turnId: string, prompt: string): Promise<TurnOutcome> {
    if (this.active && !this.active.terminal) {
      return { status: "failed", error: "deterministic adapter already has an active turn" };
    }
    const generation = ++this.generation;
    const active: ActiveDeterministicTurn = { turnId, generation, cancelled: false, terminal: false, pending: new Map(), wake: undefined };
    this.active = active;
    const scenario = this.selectScenario(prompt);

    this.emit({ kind: "session_init", providerSessionId: PROVIDER_SESSION_ID, claudeCodeVersion: "deterministic", model: "deterministic", tools: ["Read", "Bash"] });

    let index = 0;
    for (const step of scenario.steps) {
      if (active.cancelled) break;
      if (step.kind === "text") {
        const itemId = `det-text-${turnId}-${index}`;
        for (const half of splitText(step.text)) this.emit({ kind: "assistant_delta", itemId, text: half });
        this.emit({ kind: "assistant_message", itemId, text: step.text });
      } else if (step.kind === "delay") {
        if (!(await this.sleep(active, step.ms))) break;
      } else if (step.kind === "fail") {
        active.terminal = true;
        this.emit({ kind: "turn_failed", subtype: "deterministic_failure", errors: [step.error] });
        return { status: "failed", providerSessionId: PROVIDER_SESSION_ID, error: step.error };
      } else {
        const completed = await this.runToolStep(active, turnId, step, index);
        if (!completed) break;
      }
      index += 1;
    }

    active.terminal = true;
    if (active.cancelled) {
      this.emit({ kind: "turn_cancelled", reason: "deterministic_interrupt" });
      return { status: "cancelled", providerSessionId: PROVIDER_SESSION_ID };
    }
    const result = scenario.result ?? "deterministic result";
    this.emit({ kind: "turn_completed", result, costUsd: scenario.costUsd ?? 0.01, numTurns: scenario.numTurns ?? 1 });
    return { status: "completed", providerSessionId: PROVIDER_SESSION_ID };
  }

  private async runToolStep(
    active: ActiveDeterministicTurn,
    turnId: string,
    step: Extract<ScenarioStep, { kind: "tool" }>,
    index: number,
  ): Promise<boolean> {
    const toolUseId = `det-tool-${turnId}-${index}`;
    const itemId = toolUseId;
    this.emit({ kind: "tool_started", itemId, toolUseId, toolName: step.toolName, input: step.input ?? {} });

    if (step.approval) {
      const approvalId = `det-approval-${turnId}-${index}`;
      const request: ApprovalRequest = {
        approvalId,
        turnId,
        toolUseId,
        toolName: step.toolName,
        input: step.input ?? {},
        title: `Allow ${step.toolName}?`,
        description: "deterministic approval request",
        cwd: this.workspace,
        createdAt: new Date().toISOString(),
      };
      this.emit({ kind: "approval_requested", request });
      const action = await this.waitForApproval(active, request);
      if (active.cancelled) return false;
      if (action !== "allow_once") {
        this.emit({ kind: "tool_completed", itemId, toolUseId, error: "denied by user" });
        return true;
      }
    }

    if (step.durationMs && !(await this.sleep(active, step.durationMs))) return false;
    if (active.cancelled) return false;
    if (step.output) this.emit({ kind: "tool_progress", itemId, toolUseId, output: step.output });
    this.emit(step.error
      ? { kind: "tool_completed", itemId, toolUseId, error: step.error }
      : { kind: "tool_completed", itemId, toolUseId, ...(step.output ? { output: step.output } : {}) });
    return true;
  }

  private waitForApproval(active: ActiveDeterministicTurn, request: ApprovalRequest): Promise<ApprovalAction | "aborted"> {
    return new Promise((resolve) => {
      const pending: PendingDeterministicApproval = {
        request,
        settle: (action) => resolve(action),
      };
      active.pending.set(request.approvalId, pending);
      active.wake = () => {
        if (active.pending.delete(request.approvalId)) resolve("aborted");
      };
    });
  }

  private sleep(active: ActiveDeterministicTurn, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        active.wake = undefined;
        resolve(!active.cancelled);
      }, ms);
      active.wake = () => {
        clearTimeout(timer);
        active.wake = undefined;
        resolve(false);
      };
    });
  }

  async interrupt(): Promise<"accepted" | "already_terminal" | "unavailable"> {
    const active = this.active;
    if (!active) return "unavailable";
    if (active.terminal) return "already_terminal";
    active.cancelled = true;
    for (const [approvalId, pending] of [...active.pending.entries()]) {
      active.pending.delete(approvalId);
      this.emit({ kind: "approval_resolved", approvalId, toolUseId: pending.request.toolUseId, action: "aborted" });
      pending.settle("aborted");
    }
    active.wake?.();
    return "accepted";
  }

  respondApproval(approvalId: string, action: ApprovalAction): boolean {
    const active = this.active;
    const pending = active?.pending.get(approvalId);
    if (!active || !pending) return false;
    active.pending.delete(approvalId);
    this.emit({ kind: "approval_resolved", approvalId, toolUseId: pending.request.toolUseId, action });
    pending.settle(action);
    return true;
  }

  private emit(event: DistributiveOmit<AdapterEvent, "generation" | "turnId">): void {
    const active = this.active;
    const envelope = {
      ...event,
      ...(active ? { generation: active.generation, turnId: active.turnId } : {}),
    } as AdapterEvent;
    this.onEvent?.(envelope);
  }
}

function splitText(text: string): [string, string] {
  const midpoint = Math.floor(text.length / 2);
  return [text.slice(0, midpoint), text.slice(midpoint)];
}

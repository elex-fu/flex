import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionOrchestrator } from "./orchestrator.js";
import { CodexAdapter } from "../codex/adapter.js";
import { fenceAdapterEvent } from "../provider/types.js";
import { createTestHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import type { AdapterEvent, AdapterEventPayload, AdapterStatus, DispatchContext, ProviderAdapter, TurnOutcome } from "../provider/types.js";
import type { AppServerClient, AppServerClientHandlers, JsonObject, JsonRpcId } from "../codex/app-server-client.js";

const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
const open: SessionOrchestrator[] = [];
const directories: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.closeAndWait();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

class ContextAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly workspace = workspace;
  readonly calls: Array<{ context: DispatchContext; resumeSessionId?: string; settle: (outcome: TurnOutcome) => void }> = [];
  orchestrator!: SessionOrchestrator;
  async status(): Promise<AdapterStatus> {
    return { provider: this.provider, transport: "deterministic", adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true };
  }
  preflight(): Promise<AdapterStatus> { return this.status(); }
  runTurn(_turnId: string, _prompt: string, resumeSessionId?: string, context?: DispatchContext): Promise<TurnOutcome> {
    if (!context) throw new Error("Engine dispatch context missing");
    return new Promise((settle) => { this.calls.push({ context, ...(resumeSessionId ? { resumeSessionId } : {}), settle }); });
  }
  async interrupt(): Promise<"unavailable"> { return "unavailable"; }
  respondApproval(): boolean { return false; }
  emit(index: number, event: AdapterEventPayload): void {
    this.orchestrator.ingestAdapterEvent(fenceAdapterEvent(this.calls[index]!.context, event));
  }
  finish(index: number): void {
    this.emit(index, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 });
    this.calls[index]!.settle({ status: "completed", providerSessionId: "native-session" });
  }
}

function setup(options: { databasePath?: string; owner?: HostOwnerHandle } = {}) {
  const adapter = new ContextAdapter();
  const orchestrator = new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace, adapter, ...options });
  adapter.orchestrator = orchestrator;
  if (!orchestrator.store.getDevice("device")) orchestrator.store.createDevice({ id: "device", hostId: "test-host", platform: "test", credentialKind: "browser-session", scopes: ["session:write", "approval:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
  open.push(orchestrator);
  return { adapter, orchestrator };
}

async function drain(orchestrator: SessionOrchestrator): Promise<void> {
  await orchestrator.worker.drainDispatch();
  await orchestrator.ingestion.drain();
}
async function waitForTerminal(orchestrator: SessionOrchestrator, turnId: string): Promise<void> {
  if (!["completed", "failed", "cancelled", "outcome_unknown"].includes(orchestrator.store.getTurn(turnId)?.status ?? "")) {
    await new Promise<void>((resolveDone) => {
      const unsubscribe = orchestrator.subscribe((event) => {
        const payload = event.payload as { turnId?: string };
        if (payload.turnId === turnId && ["turn.completed", "turn.failed", "turn.cancelled", "turn.reconciled"].includes(event.type)) {
          unsubscribe(); resolveDone();
        }
      });
    });
  }
  await drain(orchestrator);
  expect(await orchestrator.worker.drainOperations()).toBe(true);
}

class FailingFirstThreadClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: JsonObject }> = [];
  private threadStarts = 0;
  constructor(readonly handlers: AppServerClientHandlers) {}
  async start(): Promise<void> {}
  async request<T = JsonObject>(method: string, params: JsonObject = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "config/read") return { config: {} } as T;
    if (method === "thread/start" && ++this.threadStarts === 1) throw new Error("B07 injected first thread load failure");
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "native-session" } } as T;
    if (method === "turn/start") {
      // app-server may stream before its turn/start reply is processed.
      this.handlers.onNotification({ method: "item/agentMessage/delta", params: { threadId: "native-session", turnId: "native-turn", itemId: "shared-item", delta: "Hello" } });
      this.handlers.onNotification({ method: "item/agentMessage/delta", params: { threadId: "native-session", turnId: "native-turn", itemId: "shared-item", delta: " world" } });
      this.handlers.onNotification({ method: "item/completed", params: { threadId: "native-session", turnId: "native-turn", item: { id: "shared-item", type: "agentMessage", text: "Hello world" } } });
      this.handlers.onNotification({ method: "turn/completed", params: { threadId: "native-session", turn: { id: "native-turn", status: "completed" } } });
      return { turn: { id: "native-turn" } } as T;
    }
    return {} as T;
  }
  notify(): void {}
  respond(_id: JsonRpcId, _result: JsonObject): boolean { return true; }
  respondError(_id: JsonRpcId, _code: number, _message: string): boolean { return true; }
  close(): void {}
}

describe("authoritative Engine Provider fence", () => {
  it("B07 persists the second streamed Turn after the first thread load fails", async () => {
    let orchestrator!: SessionOrchestrator;
    const adapter = new CodexAdapter({ workspace, onEvent: (event) => orchestrator.ingestAdapterEvent(event), clientFactory: (handlers) => new FailingFirstThreadClient(handlers) });
    orchestrator = new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace, adapter });
    open.push(orchestrator);
    const first = await orchestrator.startTurn("device", "first-command", "first");
    await orchestrator.worker.drainDispatch();
    await waitForTerminal(orchestrator, first.turnId);
    expect(orchestrator.store.getTurn(first.turnId)).toMatchObject({ generation: 1, status: "failed" });
    const second = await orchestrator.startTurn("device", "second-command", "second");
    await orchestrator.worker.drainDispatch();
    await waitForTerminal(orchestrator, second.turnId);
    expect(orchestrator.store.getTurn(second.turnId)).toMatchObject({ generation: 2, status: "completed", providerSessionId: "native-session" });
    expect(orchestrator.store.getCommandReceipt("device", "second-command")?.state).toBe("completed");
    expect(orchestrator.timelineItems().filter((item) => item.kind === "assistant_message")).toHaveLength(1);
    expect(orchestrator.timelineItems().find((item) => item.kind === "assistant_message")?.content).toMatchObject({ turnId: second.turnId, text: "Hello world" });
    const secondEvents = orchestrator.timeline().events.filter((event) => (event.payload as { turnId?: string }).turnId === second.turnId && ["provider.session.init", "provider.turn.bound", "assistant.message.delta", "assistant.message.completed", "turn.completed"].includes(event.type));
    expect(secondEvents.map((event) => event.type)).toEqual(["provider.session.init", "provider.turn.bound", "assistant.message.delta", "assistant.message.delta", "assistant.message.completed", "turn.completed"]);
    expect(secondEvents.every((event) => (event.payload as { generation: number }).generation === 2)).toBe(true);
    expect(secondEvents.find((event) => event.type === "provider.turn.bound")?.payload).toMatchObject({ nativeSessionId: "native-session", nativeTurnId: "native-turn" });
  });

  it("rejects every mismatched/unfenced context and keeps reused Item IDs separate across Turns", async () => {
    const owner = createTestHostOwner();
    const { adapter, orchestrator } = setup({ owner });
    const first = await orchestrator.startTurn("device", "first-command", "first");
    await orchestrator.worker.drainDispatch();
    adapter.emit(0, { kind: "session_init", provider: "codex", providerSessionId: "native-session", model: "test", runtimeVersion: "test", tools: [] });
    adapter.emit(0, { kind: "assistant_delta", itemId: "shared-item", text: "first" });
    adapter.finish(0);
    await waitForTerminal(orchestrator, first.turnId);
    const second = await orchestrator.startTurn("device", "second-command", "second");
    await orchestrator.worker.drainDispatch();
    const context = adapter.calls[1]!.context;
    expect(context).toMatchObject({ hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: orchestrator.sessionId, flyxTurnId: second.turnId, runtimeGeneration: 2 });
    expect(adapter.calls[1]!.resumeSessionId).toBe("native-session");
    adapter.emit(1, { kind: "assistant_delta", itemId: "shared-item", text: "second" });
    await drain(orchestrator);
    const head = orchestrator.snapshot().session.headSequence;
    adapter.emit(0, { kind: "assistant_delta", itemId: "shared-item", text: "late old" });
    adapter.emit(0, { kind: "turn_failed", subtype: "late", errors: ["late"] });
    adapter.emit(0, { kind: "session_init", provider: "codex", providerSessionId: "late-session", model: "test", runtimeVersion: "test", tools: [] });
    orchestrator.ingestAdapterEvent({ kind: "assistant_delta", itemId: "shared-item", text: "unfenced" } as AdapterEvent);
    orchestrator.ingestAdapterEvent({ kind: "assistant_delta", itemId: "shared-item", text: "partial", turnId: second.turnId, generation: 2 } as AdapterEvent);
    for (const key of ["hostOwnerId", "hostOwnerGeneration", "sessionId", "flyxTurnId", "runtimeId", "runtimeGeneration", "attemptId"] as const) {
      const wrong = { ...context, [key]: typeof context[key] === "number" ? 999 : "wrong-context" } as DispatchContext;
      orchestrator.ingestAdapterEvent(fenceAdapterEvent(wrong, { kind: "assistant_delta", itemId: "shared-item", text: key }));
    }
    orchestrator.ingestAdapterEvent({ ...fenceAdapterEvent(context, { kind: "assistant_delta", itemId: "shared-item", text: "wrong-alias" }), generation: 1 });
    adapter.emit(1, { kind: "approval_requested", request: { approvalId: "mismatched-approval", turnId: first.turnId, toolUseId: "shared-tool", toolName: "Bash", input: {}, cwd: ".", createdAt: new Date().toISOString() } });
    await drain(orchestrator);
    expect(orchestrator.snapshot().session.headSequence).toBe(head);
    expect(orchestrator.snapshot().activeTurn?.id).toBe(second.turnId);
    expect(orchestrator.snapshot().session.providerSessionId).toBe("native-session");
    const items = orchestrator.timelineItems().filter((item) => item.kind === "assistant_message");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: first.turnId, text: "first" }), expect.objectContaining({ turnId: second.turnId, text: "second" }),
    ]));
    expect(new Set(items.map((item) => item.itemId)).size).toBe(2);
    adapter.finish(1);
    await waitForTerminal(orchestrator, second.turnId);
  });

  it("derives the monotonic generation from durable Turns after reopening and resuming", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flyx-dispatch-fence-"));
    directories.push(directory);
    const databasePath = join(directory, "host.sqlite");
    const firstHost = setup({ databasePath });
    const first = await firstHost.orchestrator.startTurn("device", "first-command", "first");
    await firstHost.orchestrator.worker.drainDispatch();
    firstHost.adapter.emit(0, { kind: "session_init", provider: "codex", providerSessionId: "native-session", model: "test", runtimeVersion: "test", tools: [] });
    firstHost.adapter.finish(0);
    await waitForTerminal(firstHost.orchestrator, first.turnId);
    open.splice(open.indexOf(firstHost.orchestrator), 1);
    await firstHost.orchestrator.closeAndWait();
    const secondHost = setup({ databasePath });
    const second = await secondHost.orchestrator.startTurn("device", "second-command", "continue");
    await secondHost.orchestrator.worker.drainDispatch();
    expect(secondHost.adapter.calls[0]!.context).toMatchObject({ hostOwnerId: secondHost.orchestrator.owner.ownerId, hostOwnerGeneration: secondHost.orchestrator.owner.generation, runtimeGeneration: 2, flyxTurnId: second.turnId });
    expect(secondHost.orchestrator.owner.ownerId).not.toBe(firstHost.orchestrator.owner.ownerId);
    expect(secondHost.adapter.calls[0]!.resumeSessionId).toBe("native-session");
    expect(secondHost.orchestrator.store.getTurn(second.turnId)?.generation).toBe(2);
    secondHost.orchestrator.ingestAdapterEvent(fenceAdapterEvent(firstHost.adapter.calls[0]!.context, { kind: "assistant_delta", itemId: "shared-item", text: "old host" }));
    secondHost.adapter.emit(0, { kind: "assistant_delta", itemId: "shared-item", text: "resumed" });
    secondHost.adapter.finish(0);
    await waitForTerminal(secondHost.orchestrator, second.turnId);
    expect(secondHost.orchestrator.timelineItems().filter((item) => item.kind === "assistant_message").map((item) => item.content)).toEqual([expect.objectContaining({ turnId: second.turnId, text: "resumed" })]);
  });
});

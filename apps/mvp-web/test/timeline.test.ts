import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
import { SyncEngine } from "@flyx/client-core";
import { hasTerminalItem, projectSnapshot, timelineItemFromEvent, type Snapshot } from "../src/timeline.js";

function event(sequence: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { id: `event-${sequence}`, sessionId: "session-1", sequence, type, payload, occurredAt: "2026-09-08T00:00:00.000Z" };
}

test("resumed assistant and tool events preserve accumulated text and partial metadata", () => {
  const delta = timelineItemFromEvent(event(1, "assistant.message.delta", { itemId: "reply", text: "Hello", turnId: "turn-1" }));
  const completed = timelineItemFromEvent(event(2, "assistant.message.completed", { itemId: "reply", text: "Hello world" }), delta);
  assert.equal((completed!.content as Record<string, unknown>).text, "Hello world");
  assert.equal((completed!.content as Record<string, unknown>).turnId, "turn-1");
  const tool = timelineItemFromEvent(event(3, "tool.started", { itemId: "tool", toolName: "Bash", input: { command: "npm test" } }));
  const done = timelineItemFromEvent(event(4, "tool.completed", { itemId: "tool", output: "1 passing" }), tool);
  assert.deepEqual(done!.content, { itemId: "tool", toolName: "Bash", input: { command: "npm test" }, output: "1 passing", eventType: "tool.completed" });
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: catch-up preserves snapshot watermark and terminal events prevent a late response from reviving a turn`, () => {
    let snapshot: Snapshot = { session: { id: "session-1", provider, headSequence: 10, activityState: "idle" }, pendingApprovals: [] };
    const items: TimelineItem[] = [];
    const events = [
      event(1, "user.message.created", { itemId: "user", turnId: "turn-1", text: "task" }),
      event(2, "provider.session.init", { providerSessionId: "provider-session" }),
      event(3, "turn.completed", { itemId: "result", turnId: "turn-1", result: "done" }),
    ];
    for (const entry of events) {
      const item = timelineItemFromEvent(entry);
      if (item) items.push(item);
      snapshot = projectSnapshot(snapshot, entry, items)!;
    }
    assert.equal(snapshot.session.provider, provider);
    assert.equal(snapshot.session.providerSessionId, "provider-session");
    assert.equal(snapshot.session.headSequence, 10);
    assert.equal(snapshot.session.activityState, "idle");
    assert.equal(snapshot.activeTurn, undefined);
    assert.equal(hasTerminalItem(items, "turn-1"), true);
  });
}

test("pending approvals survive live projection and recovery never exposes a runnable composer", () => {
  let snapshot: Snapshot = { session: { id: "session-1", provider: "claude", activityState: "running", headSequence: 0 }, activeTurn: { id: "turn-1", status: "running", prompt: "task" }, pendingApprovals: [] };
  snapshot = projectSnapshot(snapshot, event(1, "approval.requested", { approvalId: "approval-1", toolUseId: "tool-1", turnId: "turn-1" }), [])!;
  assert.equal(snapshot.session.activityState, "waiting_approval");
  assert.equal(snapshot.pendingApprovals[0]?.approvalId, "approval-1");
  snapshot = projectSnapshot(snapshot, event(2, "session.recovery.required", { turnId: "turn-1" }), [])!;
  assert.equal(snapshot.session.activityState, "outcome_unknown");
  assert.equal(snapshot.activeTurn?.status, "outcome_unknown");
});

function applyItem(items: TimelineItem[], entry: SessionEvent): TimelineItem[] {
  const payload = entry.payload as Record<string, unknown>;
  const previous = items.find((item) => item.itemId === payload.itemId);
  const next = timelineItemFromEvent(entry, previous);
  return next ? previous ? items.map((item) => item.itemId === next.itemId ? next : item) : [...items, next] : items;
}

test("consecutive assistant deltas append and full completion replaces the accumulated body", () => {
  const first = timelineItemFromEvent(event(1, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: "Hello" }));
  const second = timelineItemFromEvent(event(2, "assistant.message.delta", { itemId: "reply", text: " world" }), first);
  assert.equal((second!.content as Record<string, unknown>).text, "Hello world");
  assert.equal(second!.status, "streaming");
  assert.equal((second!.content as Record<string, unknown>).turnId, "turn-1");
  const completed = timelineItemFromEvent(event(3, "assistant.message.completed", { itemId: "reply", text: "Hello world!" }), second);
  assert.equal((completed!.content as Record<string, unknown>).text, "Hello world!");
  assert.equal(completed!.revision, 2);
  assert.equal(completed!.status, "completed");
});

test("interleaved assistant items append independently while tool progress replaces cumulative output", () => {
  let items: TimelineItem[] = [];
  const entries = [
    event(1, "assistant.message.delta", { itemId: "reply-a", text: "Hello", turnId: "turn-1" }),
    event(2, "tool.call.started", { itemId: "tool", toolName: "Bash", input: { command: "test" }, turnId: "turn-1" }),
    event(3, "assistant.message.delta", { itemId: "reply-b", text: "另一条", turnId: "turn-1" }),
    event(4, "tool.call.progress", { itemId: "tool", output: "step 1" }),
    event(5, "assistant.message.delta", { itemId: "reply-a", text: " world" }),
    event(6, "tool.call.progress", { itemId: "tool", output: "step 1\nstep 2" }),
    event(7, "assistant.message.delta", { itemId: "reply-b", text: "消息" }),
    event(8, "tool.call.completed", { itemId: "tool", output: "step 1\nstep 2\ndone" }),
  ];
  for (const entry of entries) items = applyItem(items, entry);
  const content = (itemId: string) => items.find((item) => item.itemId === itemId)!.content as Record<string, unknown>;
  assert.equal(content("reply-a").text, "Hello world");
  assert.equal(content("reply-b").text, "另一条消息");
  assert.equal(content("tool").output, "step 1\nstep 2\ndone");
  assert.equal(content("tool").toolName, "Bash");
  assert.deepEqual(content("tool").input, { command: "test" });
  assert.equal(hasTerminalItem(items, "turn-1"), false);
});

test("an interrupted partial stream keeps its committed text without requiring an assistant completion", () => {
  let snapshot: Snapshot = { session: { id: "session-1", provider: "codex", headSequence: 0, activityState: "running" }, activeTurn: { id: "turn-1", status: "running", prompt: "task" }, pendingApprovals: [] };
  let items: TimelineItem[] = [];
  for (const entry of [
    event(1, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: "Partial " }),
    event(2, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: "answer" }),
    event(3, "turn.interrupt.requested", { turnId: "turn-1" }),
    event(4, "turn.cancelled", { itemId: "cancelled-turn-1", turnId: "turn-1", reason: "user interrupt" }),
  ]) {
    items = applyItem(items, entry);
    snapshot = projectSnapshot(snapshot, entry, items)!;
  }
  assert.equal((items.find((item) => item.itemId === "reply")!.content as Record<string, unknown>).text, "Partial answer");
  assert.equal(snapshot.activeTurn, undefined);
  assert.equal(snapshot.session.activityState, "idle");
  assert.equal(hasTerminalItem(items, "turn-1"), true);
});

test("completed assistant, tool, approval and diagnostic items do not terminate a running Turn", () => {
  const snapshot: Snapshot = { session: { id: "session-1", provider: "claude", headSequence: 0, activityState: "running" }, activeTurn: { id: "turn-1", status: "running", prompt: "task" }, pendingApprovals: [] };
  const entries = [
    event(1, "assistant.message.completed", { itemId: "reply", turnId: "turn-1", text: "still working" }),
    event(2, "tool.call.completed", { itemId: "tool", turnId: "turn-1", output: "done" }),
    event(3, "approval.resolved", { itemId: "approval", turnId: "turn-1", status: "completed" }),
    event(4, "diagnostic", { itemId: "warning", turnId: "turn-1", status: "failed", eventType: "turn.failed" }),
  ];
  let projected = snapshot;
  let items: TimelineItem[] = [];
  for (const entry of entries) {
    items = applyItem(items, entry);
    projected = projectSnapshot(projected, entry, items)!;
    assert.equal(hasTerminalItem(items, "turn-1"), false);
  }
  assert.equal(projected.activeTurn?.id, "turn-1");
  assert.equal(projected.activeTurn?.status, "running");
  assert.equal(projected.session.activityState, "running");
});

for (const status of ["completed", "failed", "cancelled", "outcome_unknown", "running"] as const) {
  test(`Turn reconciliation recognizes ${status} only from its own Turn event`, () => {
    const item = timelineItemFromEvent(event(1, "turn.reconciled", { turnId: "turn-1", outcome: { status } }))!;
    assert.equal(hasTerminalItem([item], "turn-1"), status !== "running");
    assert.equal(hasTerminalItem([item], "turn-other"), false);
  });
}

test("catch-up and live overlap append each delta once and assistant completion leaves the Turn running", async () => {
  const history = [
    event(1, "user.message.created", { itemId: "user", turnId: "turn-1", text: "task" }),
    event(2, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: "Hello" }),
    event(3, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: " world" }),
  ];
  const liveDelta = event(4, "assistant.message.delta", { itemId: "reply", turnId: "turn-1", text: "!" });
  const completion = event(5, "assistant.message.completed", { itemId: "reply", turnId: "turn-1", text: "Hello world!" });
  const authoritative: Snapshot = { session: { id: "session-1", provider: "codex", headSequence: 3, activityState: "running" }, activeTurn: { id: "turn-1", status: "running", prompt: "task" }, pendingApprovals: [] };
  let snapshot: Snapshot | null = null;
  let items: TimelineItem[] = [];
  const engine = new SyncEngine({
    isCurrent: (generation) => generation === 1,
    recover: () => assert.fail("valid overlap must not trigger recovery"),
    request: async <T>(method: string): Promise<T> => {
      if (method === "host.getSnapshot") return authoritative as T;
      if (method === "session.subscribe") {
        engine.receive(history[1]!, 1);
        engine.receive(liveDelta, 1);
        engine.receive(completion, 1);
        return {} as T;
      }
      return { events: history, upTo: 3, hasMore: false } as T;
    },
  });
  engine.onSnapshot((value) => { snapshot = value as Snapshot; });
  engine.onEvent((entry) => {
    items = applyItem(items, entry);
    snapshot = projectSnapshot(snapshot, entry, items);
  });
  await engine.synchronize(1);
  engine.receive(liveDelta, 1);
  engine.receive(completion, 1);
  const reply = items.find((item) => item.itemId === "reply")!;
  assert.equal((reply.content as Record<string, unknown>).text, "Hello world!");
  assert.equal(reply.revision, 3);
  assert.equal((snapshot as Snapshot | null)?.activeTurn?.status, "running");
  assert.equal((snapshot as Snapshot | null)?.session.headSequence, 5);
  assert.equal(hasTerminalItem(items, "turn-1"), false);
  engine.receive(event(6, "turn.completed", { itemId: "result", turnId: "turn-1", result: "done" }), 1);
  assert.equal((snapshot as Snapshot | null)?.activeTurn, undefined);
  assert.equal(hasTerminalItem(items, "turn-1"), true);
});

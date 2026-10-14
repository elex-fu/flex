import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
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
  assert.deepEqual(done!.content, { itemId: "tool", toolName: "Bash", input: { command: "npm test" }, output: "1 passing" });
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

import { afterEach, describe, expect, it } from "vitest";
import type { ProjectedItem } from "@flyx/mvp-protocol";
import { TimelineFixture } from "./test-support.js";

const fixtures: TimelineFixture[] = [];
function fixture() { const value = new TimelineFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
function ref(item: ProjectedItem): string { if (!("ref" in item.content)) throw new Error("Expected immutable body"); return item.content.ref; }

describe("authoritative timeline projector", () => {
  it("appends deltas, replaces final text, distinguishes tool snapshots from deltas, and keeps display order", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "Hello" } }]);
    f.commit([{ type: "tool.call.started", payload: { itemId: "tool", toolName: "shell", input: { path: "/tmp/fixture/src" } } }]);
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: " world" } }]);
    const q = f.query(); const epoch = q.activeEpoch(f.session.id).epoch;
    const old = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 3 });
    f.commit([{ type: "tool.call.progress", payload: { itemId: "tool", outputDelta: "A" } }]);
    f.commit([{ type: "tool.call.progress", payload: { itemId: "tool", output: "AB" } }]);
    f.commit([{ type: "tool.call.progress", payload: { itemId: "tool", outputDelta: "C" } }]);
    f.commit([{ type: "assistant.message.completed", payload: { itemId: "assistant", text: "Final answer" } }]);
    f.commit([{ type: "tool.call.completed", payload: { itemId: "tool", output: "ABC done" } }]);
    const page = q.tail(f.session.id);
    expect(page.items.map((item) => [item.itemId, item.displaySequence])).toEqual([["assistant", 1], ["tool", 2]]);
    expect(f.text(ref(page.items[0]!))).toBe("Final answer");
    expect(f.text(ref(page.items[1]!))).toBe("ABC done");
    expect(page.items[1]!.metadata).toMatchObject({ toolName: "shell", input: { path: "src" } });
    expect(f.text(ref(old.items[0]!))).toBe("Hello world");
    expect(f.text(ref(q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 1 }).items[0]!))).toBe("Hello");
    expect(page.items[0]!.sourceSeqRanges).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 7, end: 7 }]);
    const toolAsOf = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 3, upToSequence: 6 }).items[0]!;
    expect(f.text(ref(toolAsOf))).toBe("ABC");
  });

  it("keeps over 1 MiB as immutable prefixes without copying full text per version", () => {
    const f = fixture(); const chunk = "🙂 quotes \" and newline\n".repeat(7_000);
    for (let i = 0; i < 10; i++) f.commit([{ type: "assistant.message.delta", payload: { itemId: "large", text: chunk } }]);
    const q = f.query(); const epoch = q.activeEpoch(f.session.id).epoch;
    const before = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 5 }).items[0]!;
    f.commit([{ type: "assistant.message.completed", payload: { itemId: "large", text: "authoritative replacement" } }]);
    const stored = f.db.prepare(`SELECT sum(length(data)) AS bytes FROM content_segments`).get() as { bytes: number };
    const metadata = f.db.prepare(`SELECT sum(length(metadata_json)) AS bytes FROM timeline_item_versions`).get() as { bytes: number };
    expect(stored.bytes).toBe(Buffer.byteLength(chunk) * 10);
    expect(stored.bytes).toBeGreaterThan(1024 * 1024);
    expect(metadata.bytes).toBeLessThan(20_000);
    expect(f.text(ref(before))).toBe(chunk.repeat(5));
    expect(f.text(ref(q.tail(f.session.id).items[0]!))).toBe("authoritative replacement");
    f.content.sweep({ createdBefore: "9999-01-01T00:00:00.000Z" });
    expect(f.text(ref(before))).toBe(chunk.repeat(5));
  });

  it("redacts roots split across source deltas and flushes a terminal tool delta without mutating its older ref", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "path /tmp/fi" } }]);
    const old = f.query().tail(f.session.id).items[0]!;
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "xture/file" } }]);
    expect(f.text(ref(f.query().tail(f.session.id).items[0]!))).toBe("path ./file");
    expect(f.text(ref(old))).toBe("path ");
    f.commit([{ type: "tool.call.completed", payload: { itemId: "tool", outputDelta: "/tmp/fi" } }]);
    expect(f.text(ref(f.query().tail(f.session.id).items.find((item) => item.itemId === "tool")!))).toBe("/tmp/fi");
  });

  it("projects system results and recovery explanations from durable source facts", () => {
    const f = fixture();
    f.commit([{ type: "provider.session.init", payload: { provider: "codex", providerSessionId: "native" } }]);
    f.commit([{ type: "turn.completed", payload: { turnId: "turn", result: "result text", costUsd: 0 } }]);
    f.commit([{ type: "session.recovery.required", payload: { turnId: "other", reason: "host_restart" } }]);
    const items = f.query().tail(f.session.id).items;
    expect(items[0]!.content).toEqual({ inline: { provider: "codex", message: "Codex session initialized" } });
    expect(JSON.stringify(items)).not.toContain("native");
    expect(items[1]!.contentField).toBe("message"); expect(f.text(ref(items[1]!))).toBe("result text");
    expect(items[1]!.metadata).not.toHaveProperty("result");
    expect(items[2]!.status).toBe("outcome_unknown");
  });

  it("settles every affected approval in the same recovery source revision", () => {
    const f = fixture();
    f.commit([{ type: "approval.requested", payload: { approvalId: "a", toolName: "shell", status: "pending" } }]);
    f.commit([{ type: "approval.requested", payload: { approvalId: "b", status: "pending" } }]);
    f.commit([{ type: "session.recovery.required", payload: { turnId: "turn", pendingApprovalIds: ["a", "b"], reason: "host_restart" } }]);
    const q = f.query(); const epoch = q.activeEpoch(f.session.id).epoch;
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 2, upToSequence: 3 });
    expect(page.items.map((item) => [item.itemId, item.revision, item.status])).toEqual([["approval-a", 3, "superseded"], ["approval-b", 3, "superseded"], ["recovery-turn", 3, "outcome_unknown"]]);
    expect(page.items[0]!.content).toEqual({ inline: { approvalId: "a", toolName: "shell", status: "superseded", action: "aborted", reason: "host_restart", turnId: "turn" } });
  });

  it("projects canonical approval and question lifecycles without exposing dispatch context", () => {
    const f = fixture();
    f.commit([{ type: "interaction.requested", payload: { itemId: "approval-legacy", interactionId: "approval", interactionKind: "approval", status: "pending", request: { toolName: "shell" }, dispatchContext: { nativeHandle: "private" } } }]);
    f.commit([{ type: "interaction.response.accepted", payload: { itemId: "approval-legacy", interactionId: "approval", interactionKind: "approval", status: "response_accepted", response: { action: "allow_once" } } }]);
    f.commit([{ type: "interaction.requested", payload: { interactionId: "question", interactionKind: "question", status: "pending", message: "Choose an option", request: { choices: ["a", "b"] } } }]);
    const items = f.query().tail(f.session.id).items;
    expect(items.map((item) => [item.itemId, item.kind, item.status, item.displaySequence])).toEqual([["approval-legacy", "approval", "response_accepted", 1], ["interaction-question", "question", "pending", 3]]);
    expect(items[0]!.content).not.toHaveProperty("inline.dispatchContext");
    expect(JSON.stringify(items)).not.toContain("private");
  });

  it("rolls source facts, content, versions and source watermarks back together after a projection hook failure", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "committed" } }]);
    const detach = f.registerCommitHook(() => { throw new Error("fault injection"); });
    expect(() => f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: " lost" } }])).toThrow("fault injection");
    expect(f.store.getSession(f.session.id)!.headSequence).toBe(1);
    expect(f.query().activeEpoch(f.session.id).indexedSequence).toBe(1);
    expect((f.db.prepare(`SELECT count(*) AS n FROM timeline_item_versions`).get() as { n: number }).n).toBe(1);
    detach();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: " next" } }]);
    expect(f.text(ref(f.query().tail(f.session.id).items[0]!))).toBe("committed next");
  });
});

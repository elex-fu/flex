import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHostOwner, HostOwnerLock, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { ProviderAdapter } from "../provider/types.js";
import { applyViewsMigration, validateViewsSchema } from "./host-views.js";
import { TimelineQuery } from "./timeline-query.js";
import { JsonTimelineBudget } from "./contracts.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
function adapter(): ProviderAdapter {
  const status = { provider: "claude" as const, transport: "deterministic" as const, adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace, sandboxRequired: true as const };
  return { provider: "claude", workspace, status: async () => status, preflight: async () => status, runTurn: vi.fn(async () => ({ status: "completed", providerSessionId: "fixture-native" } as const)), interrupt: vi.fn(async () => "already_terminal" as const), respondApproval: vi.fn(() => false) };
}
function fixture() {
  const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
  cleanups.push(() => { store.close(); owner.release(); });
  const session = store.createSession(workspace, "claude");
  return { owner, store, session };
}

describe("owned Timeline migration and Host lifecycle", () => {
  it("backfills before marking006, resumes idempotently and does not invent a005 marker", () => {
    const f = fixture(); const hadFive = Boolean(f.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get());
    f.store.commitEvent(f.session.id, "assistant.message.completed", { itemId: "history", text: `history ${workspace}` });
    applyViewsMigration(f.store, f.owner); validateViewsSchema(f.store.db);
    const epoch = f.store.db.prepare("SELECT epoch, indexed_sequence FROM timeline_epochs WHERE state = 'active'").get() as { epoch: string; indexed_sequence: number };
    expect(epoch.indexed_sequence).toBe(1);
    expect(Boolean(f.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get())).toBe(hadFive);
    expect(f.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get()).toBeDefined();
    applyViewsMigration(f.store, f.owner);
    expect((f.store.db.prepare("SELECT epoch FROM timeline_epochs WHERE state = 'active'").get() as { epoch: string }).epoch).toBe(epoch.epoch);
    const fake = { ...f.owner } as HostOwnerHandle;
    expect(() => applyViewsMigration(f.store, fake)).toThrow("verified Host owner");
  });

  it.each([
    "DROP INDEX one_active_timeline_epoch",
    "DROP INDEX one_active_timeline_epoch; CREATE UNIQUE INDEX one_active_timeline_epoch ON timeline_epochs(session_id, epoch) WHERE state = 'active'",
    "DROP INDEX one_active_timeline_epoch; CREATE UNIQUE INDEX one_active_timeline_epoch ON timeline_epochs(session_id) WHERE state = 'active' OR state = 'building'",
    "ALTER TABLE timeline_item_versions RENAME COLUMN metadata_json TO malformed_metadata",
  ])("rejects a corrupt declared006 without repairing it: %s", (corruption) => {
    const f = fixture(); applyViewsMigration(f.store, f.owner); f.store.db.exec(corruption);
    const before = JSON.stringify(f.store.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all());
    expect(() => applyViewsMigration(f.store, f.owner)).toThrow("offline repair");
    expect(JSON.stringify(f.store.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all())).toBe(before);
  });

  it("does not activate a source-gap build or mark006 on failed backfill", () => {
    const f = fixture();
    // Remove the optional central runner's empty006 marker to exercise the exported migration boundary itself.
    f.store.db.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    f.store.commitEvent(f.session.id, "provider.heartbeat", {}); f.store.commitEvent(f.session.id, "provider.heartbeat", {});
    f.store.db.prepare("DELETE FROM session_events WHERE session_id = ? AND sequence = 1").run(f.session.id);
    expect(() => applyViewsMigration(f.store, f.owner)).toThrow("gap");
    expect(f.store.db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get()).toBeUndefined();
    expect(f.store.db.prepare("SELECT 1 FROM timeline_epochs WHERE session_id = ? AND state = 'active'").get(f.session.id)).toBeUndefined();
  });

  it("attaches projection before restart recovery and closes every actor subscription", async () => {
    const f = fixture();
    // Legacy facts have no execution intent. R06 owns recovery of current durable intents.
    f.store.createTurn({ authSubjectId: "device", commandId: "start", requestHash: "start", sessionId: f.session.id, turnId: "pending-turn", prompt: "work", generation: 1 });
    f.store.commitEvent(f.session.id, "approval.requested", { approvalId: "approval", itemId: "approval-approval", toolName: "Bash" }, {
      activityState: "waiting_approval", turnId: "pending-turn", turnStatus: "waiting_approval", approval: { approvalId: "approval", sessionId: f.session.id, turnId: "pending-turn", toolUseId: "tool", version: 0, status: "pending", request: { toolName: "Bash", input: { command: "work" } }, createdAt: "2026-10-14T00:00:00.000Z" },
    });
    applyViewsMigration(f.store, f.owner);
    const orch = new SessionOrchestrator({ store: f.store, owner: f.owner, workspace, adapter: adapter() });
    cleanups.push(() => orch.close());
    const views = orch.views!; expect(views.ready(orch.sessionId)).toBe(true);
    const query = new TimelineQuery(f.store.db, views.content, { workspaceForSession: () => workspace });
    const tail = query.tail(orch.sessionId);
    expect(tail.items.find((item) => item.itemId === "approval-approval")?.status).toBe("superseded");
    expect(tail.items.find((item) => item.itemId === "recovery-pending-turn")?.status).toBe("outcome_unknown");
    expect(tail.nextCursor?.sequence).toBe(orch.snapshot().session.headSequence);
    const connection = views.connect({ subjectId: "device", leaseId: "lease", generation: 1 }, new JsonTimelineBudget(32 * 1024), () => {});
    const opened = connection.openView({ sessionId: orch.sessionId, tailLimit: 10 }, async () => {}); await opened.activate();
    expect(connection.subscriptionCount).toBe(1);
    orch.close(); expect(connection.subscriptionCount).toBe(0); expect(views.ready(orch.sessionId)).toBe(false);
  });

  it("captures complete injected Interaction pages at the same canonical watermark", () => {
    const f = fixture(); applyViewsMigration(f.store, f.owner);
    const readInteractions = vi.fn((_id: string, after?: string) => after ? { interactions: [{ id: "b", status: "pending" }], hasMore: false } : { interactions: [{ id: "a", status: "responding" }], hasMore: true, nextAfterInteractionId: "a" });
    const orch = new SessionOrchestrator({ store: f.store, owner: f.owner, workspace, adapter: adapter(), readViewInteractions: readInteractions }); cleanups.push(() => orch.close());
    const connection = orch.views!.connect({ subjectId: "device", leaseId: "lease", generation: 1 }, new JsonTimelineBudget(32 * 1024), () => {});
    const opened = connection.openView({ sessionId: orch.sessionId, tailLimit: 10 }, async () => {});
    expect(opened.response.interactions).toEqual({ total: 2, directoryRevision: 0, complete: true, items: [{ id: "a", status: "responding" }, { id: "b", status: "pending" }] });
    expect(readInteractions.mock.calls).toEqual([[orch.sessionId, undefined], [orch.sessionId, "a"]]); opened.cancel();
  });

  it("cleanly reopens an owned006 Store with the same active epoch and no replay", () => {
    const root = mkdtempSync(join(tmpdir(), "flyx-views-owned-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const paths = { databasePath: join(root, "data", "flyx.sqlite"), identityDirectory: join(root, "identity"), coordinationDirectory: join(root, "owners") };
    let owner = HostOwnerLock.acquire(paths);
    // The production Orchestrator creates the database parent after ownership and privacy checks.
    let orch = new SessionOrchestrator({ ...paths, owner, workspace, adapter: adapter() }); cleanups.push(() => orch.close());
    orch.store.commitEvent(orch.sessionId, "assistant.message.completed", { itemId: "persisted", text: "persisted ".repeat(40_000) + workspace });
    applyViewsMigration(orch.store, owner);
    orch.close();
    owner = HostOwnerLock.acquire(paths); orch = new SessionOrchestrator({ ...paths, owner, workspace, adapter: adapter() });
    const epoch = orch.views!.projector.activeEpoch(orch.sessionId)!.epoch;
    const view = orch.views!.connect({ subjectId: "device", leaseId: "lease", generation: 1 }, new JsonTimelineBudget(32 * 1024), () => {}).openView({ sessionId: orch.sessionId, tailLimit: 10 }, async () => {});
    expect(view.response.watermark.sequence).toBe(1); expect(view.response.page.items.map((item) => item.itemId)).toEqual(["persisted"]); view.cancel();
    orch.close(); owner = HostOwnerLock.acquire(paths); orch = new SessionOrchestrator({ ...paths, owner, workspace, adapter: adapter() });
    expect(orch.views!.projector.activeEpoch(orch.sessionId)!.epoch).toBe(epoch);
    expect(orch.snapshot().session.headSequence).toBe(1); expect(orch.store.listEventCommits(orch.sessionId)).toHaveLength(1);
  });
});

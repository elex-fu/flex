import { afterEach, describe, expect, it } from "vitest";
import { TimelineBackfill } from "./backfill.js";
import { TimelineProjector } from "./projector.js";
import { TimelineFixture } from "./test-support.js";
import { TimelineSubscriptions } from "./timeline-subscriptions.js";
import type { SessionEvent } from "@flyx/mvp-protocol";

const fixtures: TimelineFixture[] = [];
function fixture() { const value = new TimelineFixture(); fixtures.push(value); return value; }
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

describe("timeline epoch backfill", () => {
  it("backfills legacy source facts in resumable building chunks before exposing an active epoch", () => {
    const f = fixture(); f.stopProjecting();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "Hello" } }], { legacy: true });
    f.commit([{ type: "provider.heartbeat" }], { legacy: true });
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: " world" } }], { legacy: true });
    const backfill = new TimelineBackfill(f.projector); const building = backfill.begin(f.session.id);
    expect(backfill.step(f.session.id, building.epoch, 1).switched).toBe(false);
    expect(() => f.query().tail(f.session.id)).toThrow("not ready");
    const progress = backfill.run(f.session.id, { epoch: building.epoch, batchSize: 1 });
    expect(progress).toMatchObject({ indexedSequence: 3, targetSequence: 3, switched: true });
    const page = f.query().tail(f.session.id);
    expect(page.boundaryComplete).toBe(false);
    expect(page.items[0]!.revision).toBe(3);
    if (!("ref" in page.items[0]!.content)) throw new Error("Expected text ref");
    expect(f.text(page.items[0]!.content.ref)).toBe("Hello world");
  });

  it("validates building refs, catches up new commits, switches atomically and expires the retired cursor", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "Hello" } }]);
    f.commit([{ type: "provider.heartbeat" }]);
    const old = f.query().activeEpoch(f.session.id);
    const projector = new TimelineProjector(f.db, f.content, { workspaceForSession: () => "/tmp/fixture", projectorVersion: 2 });
    const backfill = new TimelineBackfill(projector); const building = backfill.begin(f.session.id);
    backfill.step(f.session.id, building.epoch, 1);
    const row = f.db.prepare(`SELECT metadata_json FROM timeline_item_versions WHERE epoch = ?`).get(building.epoch) as { metadata_json: string };
    const changed = JSON.parse(row.metadata_json) as { bodyRef: { sha256: string } }; changed.bodyRef.sha256 = "0".repeat(64);
    f.db.prepare(`UPDATE timeline_item_versions SET metadata_json = ? WHERE epoch = ?`).run(JSON.stringify(changed), building.epoch);
    f.commit([{ type: "assistant.message.completed", payload: { itemId: "assistant", text: "Final" } }]);
    expect(backfill.step(f.session.id, building.epoch, 1).switched).toBe(false);
    expect(() => backfill.step(f.session.id, building.epoch, 1)).toThrow("reference is inconsistent");
    expect(f.query().activeEpoch(f.session.id).epoch).toBe(old.epoch);
    f.db.prepare(`UPDATE timeline_item_versions SET metadata_json = ? WHERE epoch = ? AND revision = 1`).run(row.metadata_json, building.epoch);
    expect(backfill.validateAndActivate(f.session.id, building.epoch)).toBe(true);
    expect(f.query().activeEpoch(f.session.id)).toMatchObject({ epoch: building.epoch, projectorVersion: 2, indexedSequence: 3 });
    expect(() => f.query().getPage({ sessionId: f.session.id, epoch: old.epoch, direction: "after", afterSequence: 0, upToSequence: 3 })).toThrow("epoch has changed");
    expect((f.db.prepare(`SELECT state FROM timeline_epochs WHERE epoch = ?`).get(old.epoch) as { state: string }).state).toBe("retired");
  });

  it("rejects missing source facts and leaves a failed building epoch hidden", () => {
    const f = fixture(); f.stopProjecting();
    f.commit([{ type: "provider.heartbeat" }, { type: "provider.heartbeat" }, { type: "provider.heartbeat" }], { legacy: true });
    f.db.prepare(`DELETE FROM session_events WHERE sequence = 2`).run();
    const backfill = new TimelineBackfill(f.projector); const building = backfill.begin(f.session.id);
    expect(() => backfill.run(f.session.id, { epoch: building.epoch })).toThrow("coverage has a gap");
    expect(() => f.query().tail(f.session.id)).toThrow("not ready");
  });

  it("rejects inconsistent commit boundaries during backfill validation", () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    f.db.prepare(`UPDATE event_commits SET last_sequence = 2`).run();
    const backfill = new TimelineBackfill(f.projector); const building = backfill.begin(f.session.id);
    expect(() => backfill.run(f.session.id, { epoch: building.epoch })).toThrow("commit boundary is inconsistent");
    expect(f.query().activeEpoch(f.session.id).epoch).not.toBe(building.epoch);
  });

  it("checks the actual immutable bytes before activating a rebuilt epoch", () => {
    const f = fixture();
    f.commit([{ type: "assistant.message.delta", payload: { itemId: "assistant", text: "Hello" } }]);
    const old = f.query().activeEpoch(f.session.id).epoch;
    const backfill = new TimelineBackfill(f.projector); const building = backfill.begin(f.session.id);
    const source = f.db.prepare(`SELECT id, session_id, sequence, type, payload_json, occurred_at FROM session_events`).get() as { id: string; session_id: string; sequence: number; type: string; payload_json: string; occurred_at: string };
    f.projector.projectCommittedBatch([{ id: source.id, sessionId: source.session_id, sequence: source.sequence, type: source.type, payload: JSON.parse(source.payload_json) as unknown, occurredAt: source.occurred_at }], building.epoch);
    const stream = f.db.prepare(`SELECT c.stream_id FROM content_refs c JOIN timeline_item_versions v ON v.content_ref = c.id WHERE v.epoch = ?`).get(building.epoch) as { stream_id: string };
    f.db.prepare(`UPDATE content_segments SET data = ? WHERE stream_id = ?`).run(Buffer.from("Jello"), stream.stream_id);
    expect(() => backfill.validateAndActivate(f.session.id, building.epoch)).toThrow("checksum is inconsistent");
    expect(f.query().activeEpoch(f.session.id).epoch).toBe(old);
  });

  it("resets an existing live subscription when a rebuilt epoch changes", async () => {
    const f = fixture(); f.commit([{ type: "provider.heartbeat" }]);
    const sent: SessionEvent[] = [];
    const service = new TimelineSubscriptions(f.query(), { source: f.source, readSnapshot: () => f.snapshot() });
    const opened = service.openView({ sessionId: f.session.id, tailLimit: 1 }, { subjectId: "device", leaseId: "lease", generation: 1 }, async (event) => { sent.push(event); });
    await opened.activate();
    new TimelineBackfill(f.projector).run(f.session.id);
    f.commit([{ type: "provider.heartbeat" }]);
    expect(sent[0]!.type).toBe("timeline.reset"); expect(sent[0]!.payload).toMatchObject({ reason: "epoch_changed" });
    expect(service.size).toBe(0); expect(f.source.listeners.size).toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { TimelineFixture } from "./test-support.js";
const fixtures: TimelineFixture[] = [];
function fixture() { const f = new TimelineFixture(); fixtures.push(f); f.projector.attach(f.store); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const accepted = (f: TimelineFixture) => f.store.acceptTurn({ authSubjectId: "device", sessionId: f.session.id, turnId: "turn", commandId: "start", requestHash: "hash", prompt: "accepted prompt", generation: 1 });

describe("R05 and R09 shared commit transaction", () => {
  it("projects actual acceptTurn's two source facts as one complete durable batch", () => {
    const f = fixture();
    let sawReceiptAndIntent = false;
    f.store.registerCommitHook(() => {
      expect(f.db.inTransaction).toBe(true);
      sawReceiptAndIntent = f.store.getCommandReceipt("device", "start")?.state === "accepted"
        && (f.db.prepare(`SELECT count(*) AS n FROM execution_intents`).get() as { n: number }).n === 1;
    });
    const result = accepted(f);
    expect(sawReceiptAndIntent).toBe(true); expect(result.events.map((event) => event.sequence)).toEqual([1, 2]);
    const q = f.query({ sourcePageLimit: 1 }); const epoch = q.activeEpoch(f.session.id).epoch;
    const page = q.getPage({ sessionId: f.session.id, epoch, direction: "after", afterSequence: 0, upToSequence: 2 });
    expect(page.coveredSourceRange).toEqual({ fromExclusive: 0, through: 2 }); expect(page.items[0]!.itemId).toBe("user-turn");
    expect(page.items[0]!.revision).toBe(1); expect(page.boundaryComplete).toBe(true);
    if (!("ref" in page.items[0]!.content)) throw new Error("Expected accepted prompt ref");
    expect(f.text(page.items[0]!.content.ref)).toBe("accepted prompt");
  });
  it("rolls an actual command's receipt, intent, source facts and canonical versions back on hook failure", () => {
    const f = fixture();
    f.store.registerCommitHook(() => { throw new Error("projection fault"); });
    expect(() => accepted(f)).toThrow("projection fault");
    expect(f.store.getSession(f.session.id)!.headSequence).toBe(0);
    expect(f.store.getCommandReceipt("device", "start")).toBeUndefined();
    expect(f.store.getTurn("turn")).toBeUndefined();
    for (const table of ["session_events", "event_commits", "execution_intents", "content_refs", "content_pins", "timeline_epochs", "timeline_item_versions"]) expect((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
  });
});

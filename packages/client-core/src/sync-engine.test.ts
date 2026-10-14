import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@flyx/mvp-protocol";
import { SyncEngine } from "./sync-engine.js";

const event = (sequence: number, sessionId = "session-a"): SessionEvent => ({ id: `event-${sequence}`, sessionId, sequence, type: "assistant.message.delta", payload: { text: String(sequence) }, occurredAt: "now" });
describe("watermark timeline synchronization", () => {
  it("buffers live overlap while replaying bounded pages, with no gaps or duplicates", async () => {
    let recoveries = 0;
    const emitted: number[] = [];
    const pages: unknown[] = [];
    const engine = new SyncEngine({
      isCurrent: (generation) => generation === 1,
      recover: () => { recoveries++; },
      request: async <T>(method: string, payload?: unknown): Promise<T> => {
        const input = payload as Record<string, number>;
        if (method === "host.getSnapshot") return { session: { id: "session-a", headSequence: 3 } } as T;
        if (method === "session.subscribe") { engine.receive(event(2), 1); engine.receive(event(4), 1); return {} as T; }
        pages.push(payload);
        return (input.afterSequence === 0 ? { events: [event(1), event(2)], upTo: 3, nextAfter: 2, hasMore: true } : { events: [event(3)], upTo: 3, hasMore: false }) as T;
      },
    });
    engine.onEvent((value) => emitted.push(value.sequence));
    await engine.synchronize(1);
    expect(emitted).toEqual([1, 2, 3, 4]);
    expect(engine.lastSequence).toBe(4);
    expect(pages).toEqual([{ sessionId: "session-a", afterSequence: 0, limit: 200, upTo: 3 }, { sessionId: "session-a", afterSequence: 2, limit: 200, upTo: 3 }]);
    engine.receive(event(4), 1);
    engine.receive(event(6), 1);
    expect(emitted).toEqual([1, 2, 3, 4]);
    expect(recoveries).toBe(1);
  });

  it("does not advance across a missing event or changed watermark", async () => {
    for (const response of [{ events: [event(2)], upTo: 2, hasMore: false }, { events: [event(1)], upTo: 3, hasMore: false }]) {
      const projected: number[] = [];
      const engine = new SyncEngine({ isCurrent: () => true, recover: () => {}, request: async <T>(method: string) => (method === "host.getSnapshot" ? { session: { id: "session-a", headSequence: 2 } } : method === "session.subscribe" ? {} : response) as T });
      engine.onEvent((value) => projected.push(value.sequence));
      await expect(engine.synchronize(1)).rejects.toMatchObject({ code: "TIMELINE_GAP" });
      expect(projected).toEqual([]);
      expect(engine.lastSequence).toBe(0);
    }
  });

  it("fences an in-progress snapshot after generation replacement", async () => {
    let resolveOld!: (snapshot: unknown) => void;
    let generation = 1;
    let snapshots = 0;
    const engine = new SyncEngine({ isCurrent: (value) => value === generation, recover: () => {}, request: async <T>(method: string): Promise<T> => {
      if (method !== "host.getSnapshot") return {} as T;
      if (generation === 1) return new Promise((resolve) => { resolveOld = (snapshot) => resolve(snapshot as T); });
      return { session: { id: "new-session", headSequence: 0 } } as T;
    } });
    engine.onSnapshot(() => { snapshots++; });
    const old = engine.synchronize(1);
    generation = 2;
    await engine.synchronize(2);
    resolveOld({ session: { id: "old-session", headSequence: 100 } });
    await old;
    expect(snapshots).toBe(2);
    expect(engine.lastSequence).toBe(0);
  });
});

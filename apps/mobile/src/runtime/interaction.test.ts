import { describe, expect, it } from "vitest";
import { InteractionSchema } from "@flyx/mvp-protocol";
import type { FlyxClient } from "@flyx/client-core";
import { interactionAvailable, respondInteraction } from "./interaction";
function fixture() {
  const shown = InteractionSchema.parse({ kind: "question", interactionId: "interaction-a", sessionId: "session-a", turnId: "turn-a", version: 2, status: "pending", deliveryState: "none", evidenceKind: "native_request", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), responseAvailable: true, allowedActions: ["answer"], request: { blocking: true, questions: [{ questionId: "q-a", header: "Choice", question: "Choose one", options: [{ optionId: "option-a", label: "A", description: "" }], multiSelect: false, allowFreeText: false, secret: false }] } });
  const replica = { sessionId: "session-a", sync: "synced", stale: false, interactionsAuthoritative: true }; const sent: { method: string; payload: unknown }[] = []; let current = shown, currentFence = true;
  const client = { getState: () => ({ connection: "online" }), replica: { getState: () => replica, currentFence: () => ({ sessionId: "session-a" }), isCurrent: () => currentFence }, request: async () => current, command: async (method: string, payload: unknown) => { sent.push({ method, payload }); } } as unknown as FlyxClient;
  return { client, shown, replica, sent, change: () => { current = { ...shown, version: 3 }; }, replace: () => { currentFence = false; } };
}
describe("native Interaction actions query current authority", () => {
  it("requires synced live authority and exact question IDs", async () => {
    const f = fixture(); f.replica.stale = true; expect(interactionAvailable(f.client, f.shown, ["approval:write"])).toBe(false); f.replica.stale = false;
    await expect(respondInteraction(f.client, f.shown, ["approval:write"], [{ questionId: "q-a", optionIds: ["A"] }])).rejects.toThrow("QUESTION_ANSWER_INVALID"); expect(f.sent).toEqual([]);
    await respondInteraction(f.client, f.shown, ["approval:write"], [{ questionId: "q-a", optionIds: ["option-a"] }]); expect(f.sent[0]).toMatchObject({ method: "question.respond", payload: { expectedVersion: 2 } });
  });
  it("rejects updated or generation-replaced records before any mutation", async () => {
    const f = fixture(); f.change(); await expect(respondInteraction(f.client, f.shown, ["approval:write"], [{ questionId: "q-a", optionIds: ["option-a"] }])).rejects.toMatchObject({ code: "INTERACTION_STALE" }); expect(f.sent).toEqual([]);
    const g = fixture(); g.replace(); await expect(respondInteraction(g.client, g.shown, ["approval:write"], [{ questionId: "q-a", optionIds: ["option-a"] }])).rejects.toMatchObject({ code: "INTERACTION_STALE" }); expect(g.sent).toEqual([]);
    expect(interactionAvailable(g.client, { ...g.shown, responseAvailable: false }, ["approval:write"])).toBe(false); expect(interactionAvailable(g.client, { ...g.shown, expiresAt: new Date(Date.now() - 1).toISOString() }, ["approval:write"])).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./db.js";
import { ExecutionStore } from "./execution-store.js";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { decideAcceptTurn } from "../orchestration/decider.js";

const open: SqliteStore[] = [];
afterEach(() => { for (const store of open.splice(0)) store.close(); });
function fixture() {
  const store = new SqliteStore(); open.push(store);
  const selected = store.createSession("/tmp/selected-legacy"); const other = store.createSession("/tmp/other-legacy"); const durable = store.createSession("/tmp/durable");
  for (const session of [selected, other]) store.createTurn({ sessionId: session.id, turnId: session.id + "-turn", commandId: session.id + "-command", requestHash: "legacy", prompt: "legacy fact", generation: 1 });
  const request = { authSubjectId: "device", commandId: "durable-command", method: "session.startTurn", targetSessionId: durable.id,
    requestHash: hashCommandRequest("session.startTurn", { prompt: "persisted" }), dispatchBinding: { hostOwnerId: "original-owner", hostOwnerGeneration: 1, runtimeId: "original-runtime" } };
  const accepted = new CommandEngine(store).commitRequest(request, (facts, clock) => decideAcceptTurn(facts, request, { prompt: "persisted" }, clock));
  return { store, selected, other, durable, accepted, execution: new ExecutionStore(store) };
}

describe("selected legacy-only recovery", () => {
  it("does not rewrite another Session or any durable intent", () => {
    const f = fixture(); const other = f.store.getSnapshot(f.other.id); const durable = f.store.getSnapshot(f.durable.id); const intent = f.execution.get(f.accepted.intents[0]!.id);
    expect(f.store.recoverActiveTurns({ sessionId: f.selected.id, legacyOnly: true })).toEqual([{ sessionId: f.selected.id, turnId: f.selected.id + "-turn" }]);
    expect(f.store.getSnapshot(f.other.id)).toEqual(other); expect(f.store.getSnapshot(f.durable.id)).toEqual(durable); expect(f.execution.get(f.accepted.intents[0]!.id)).toEqual(intent);
    expect(f.store.recoverActiveTurns({ sessionId: f.durable.id, legacyOnly: true })).toEqual([]);
    expect(f.execution.get(f.accepted.intents[0]!.id)).toMatchObject({ state: "pending", dispatchContext: { hostOwnerId: "original-owner" } });
  });
  it("retains the unrestricted default recovery behavior", () => {
    const f = fixture(); const rows = f.store.recoverActiveTurns();
    expect(new Set(rows.map((row) => row.sessionId))).toEqual(new Set([f.selected.id, f.other.id, f.durable.id]));
    expect(f.execution.get(f.accepted.intents[0]!.id)?.state).toBe("outcome_unknown");
    expect(f.store.recoverActiveTurns()).toEqual([]);
  });
});

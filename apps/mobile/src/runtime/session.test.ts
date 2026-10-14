import { describe, expect, it } from "vitest";
import { readSessionSnapshot, sessionIsIdle } from "./session";
describe("native authoritative session selection", () => {
  it("accepts public catalog IDs and the explicit legacy facade", () => {
    expect(readSessionSnapshot({ session: { sessionId: "session-a", activityState: "waiting_question" }, activeTurn: { id: "turn-a" } }, "session-a")).toEqual({ sessionId: "session-a", activityState: "waiting_question", activeTurnId: "turn-a" });
    expect(sessionIsIdle({ session: { id: "session-a", activityState: "idle" } }, "session-a")).toBe(true);
    expect(sessionIsIdle({ session: { sessionId: "session-a", activityState: "running" } }, "session-a")).toBe(false);
  });
  it("never enables another or ambiguously identified Session", () => {
    expect(sessionIsIdle({ session: { sessionId: "session-b", activityState: "idle" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ session: { id: "session-a", sessionId: "session-b", activityState: "idle" } }, "session-a")).toBe(false);
    expect(sessionIsIdle({ session: { activityState: "idle" } }, "session-a")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { RecoveryAcknowledgePayloadSchema, RecoveryInspectPayloadSchema, RecoveryReconcilePayloadSchema } from "./recovery-api.js";
const original = { sessionId: "session", turnId: "original-turn", attemptId: "original-attempt", evidenceId: "evidence", expectedRecoveryRevision: 3 };
describe("strict recovery request contracts", () => {
  it("binds writes to an evidence ID and expected facts revision", () => {
    expect(RecoveryReconcilePayloadSchema.parse(original)).toEqual(original);
    expect(RecoveryReconcilePayloadSchema.safeParse({ ...original, expectedRecoveryRevision: -1 }).success).toBe(false);
    expect(RecoveryReconcilePayloadSchema.safeParse({ ...original, nativeOutcome: "completed" }).success).toBe(false);
  });
  it("requires explicit unknown acknowledgment without client-supplied process proof", () => {
    expect(RecoveryAcknowledgePayloadSchema.safeParse(original).success).toBe(false);
    expect(RecoveryAcknowledgePayloadSchema.parse({ ...original, acknowledgeUnknown: true }).acknowledgeUnknown).toBe(true);
    expect(RecoveryAcknowledgePayloadSchema.safeParse({ ...original, acknowledgeUnknown: true, treeStopped: true }).success).toBe(false);
  });
  it("permits legacy inspect without inventing an attempt but rejects routing guesses", () => {
    expect(RecoveryInspectPayloadSchema.parse({ sessionId: "session", turnId: "legacy-turn" })).toEqual({ sessionId: "session", turnId: "legacy-turn" });
    expect(RecoveryInspectPayloadSchema.safeParse({ sessionId: "session", turnId: "legacy-turn", prompt: "find matching prompt" }).success).toBe(false);
  });
});

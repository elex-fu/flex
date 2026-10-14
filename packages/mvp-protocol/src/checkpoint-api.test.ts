import { describe, expect, it } from "vitest";
import { CheckpointGetDiffSchema, CheckpointGetFileSchema, CheckpointGetSessionDiffSchema, CheckpointGetTurnDiffSchema, CheckpointPreviewRevertSchema } from "./checkpoint-api.js";

describe("checkpoint query schemas", () => {
  it("accepts controlled checkpoint/file IDs with bounded pages and never accepts caller refs/paths/native bindings", () => {
    expect(CheckpointGetDiffSchema.parse({ sessionId: "session", beforeCheckpointId: "before", afterCheckpointId: "after" })).toMatchObject({ limit: 100, layer: "workspace" });
    expect(CheckpointGetSessionDiffSchema.parse({ sessionId: "session", currentCheckpointId: "current" })).toMatchObject({ limit: 100, layer: "workspace" });
    expect(CheckpointGetTurnDiffSchema.safeParse({ sessionId: "s", turnId: "t", attemptId: "a", limit: 201 }).success).toBe(false);
    expect(CheckpointGetDiffSchema.safeParse({ sessionId: "s", beforeCheckpointId: "before", afterCheckpointId: "after", ref: "HEAD" }).success).toBe(false);
    expect(CheckpointGetFileSchema.safeParse({ sessionId: "s", diffId: "d", fileId: "f", path: "../../private" }).success).toBe(false);
    expect(CheckpointPreviewRevertSchema.safeParse({ sessionId: "s", checkpointId: "c", expectedSessionRevision: 1, nativeHandle: "forged", leaseId: "forged" }).success).toBe(false);
  });
});

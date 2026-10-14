import { describe, expect, it } from "vitest";
import { BootstrapSchema, FrameSchema, ProtocolVersion, SessionSchema } from "./index.js";

describe("MVP protocol frames", () => {
  it("accepts both success and error responses without duplicate discriminator failures", () => {
    expect(FrameSchema.parse({ type: "response", id: "1", ok: true, payload: {} })).toMatchObject({ ok: true });
    expect(FrameSchema.parse({ type: "response", id: "2", ok: false, error: { code: "X", message: "bad" } })).toMatchObject({ ok: false });
  });

  it("accepts both supported providers and rejects an unknown runtime", () => {
    expect(SessionSchema.parse({
      id: "session-1",
      workspaceId: "default",
      provider: "codex",
      status: "active",
      activityState: "idle",
      headSequence: 0,
    }).provider).toBe("codex");
    expect(BootstrapSchema.parse({
      protocolVersion: ProtocolVersion,
      provider: "claude",
      capabilities: {
        streamingText: true,
        structuredToolCalls: true,
        interactiveApprovals: true,
        resumeConversation: true,
        interrupt: true,
        gitDiff: true,
        sandboxRequired: true,
      },
    }).provider).toBe("claude");
    expect(() => SessionSchema.parse({
      id: "session-2",
      workspaceId: "default",
      provider: "other",
      status: "active",
      activityState: "idle",
      headSequence: 0,
    })).toThrow();
  });

  it("keeps the legacy v1 bootstrap decoder during the v2 migration window", () => {
    const current = BootstrapSchema.parse({
      protocolVersion: ProtocolVersion,
      provider: "claude",
      capabilities: {
        streamingText: true, structuredToolCalls: true, interactiveApprovals: true,
        resumeConversation: true, interrupt: true, gitDiff: true, sandboxRequired: true,
      },
    });
    expect(BootstrapSchema.parse({ ...current, protocolVersion: 1 }).protocolVersion).toBe(1);
    expect(BootstrapSchema.safeParse({ ...current, protocolVersion: 3 }).success).toBe(false);
  });
});

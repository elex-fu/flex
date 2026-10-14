import { describe, expect, it } from "vitest";
import { publicValue } from "./public-projection.js";

describe("public runtime facts", () => {
  it("keeps source facts private before content is hashed or sent over either transport", () => {
    const source = { text: "read /private/workspace/file", turnId: "turn", dispatchContext: { hostOwnerId: "secret-owner" },
      providerSessionId: "provider-session", nativeTurnId: "native-turn", nested: { nativeSessionId: "native-session", nativeItemId: "native-item", allowed: "visible" } };
    expect(publicValue(source, "/private/workspace")).toEqual({ text: "read ./file", turnId: "turn", nested: { allowed: "visible" } });
    expect(source.text).toBe("read /private/workspace/file");
  });
  it("keeps native terminal and process proof source identities out of public outcome bodies", () => {
    const source = { status: "completed", outcome: { status: "completed", evidence: { kind: "native-terminal", sourceId: "native-turn:private-source" } },
      terminalEvidence: { kind: "native-terminal", sourceId: "sdk-private-uuid" },
      boundaryEvidence: { proof: { policyDigest: "private" }, launchDigest: "private-launch" },
      stopProof: { kind: "verified-tree-stop", sourceId: "private-process-source" },
      userOutput: { evidence: "tests passed", sourceId: "public-document" } };
    expect(publicValue(source, "/workspace")).toEqual({ status: "completed", outcome: { status: "completed" }, userOutput: { evidence: "tests passed", sourceId: "public-document" } });
    expect(source.outcome.evidence.sourceId).toBe("native-turn:private-source");
  });
});

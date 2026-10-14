import { describe, expect, it } from "vitest";
import { publicValue } from "./public-projection.js";

describe("public runtime facts", () => {
  it("keeps source facts private before content is hashed or sent over either transport", () => {
    const source = { text: "read /private/workspace/file", turnId: "turn", dispatchContext: { hostOwnerId: "secret-owner" },
      providerSessionId: "provider-session", nativeTurnId: "native-turn", nested: { nativeSessionId: "native-session", nativeItemId: "native-item", allowed: "visible" } };
    expect(publicValue(source, "/private/workspace")).toEqual({ text: "read ./file", turnId: "turn", nested: { allowed: "visible" } });
    expect(source.text).toBe("read /private/workspace/file");
  });
});

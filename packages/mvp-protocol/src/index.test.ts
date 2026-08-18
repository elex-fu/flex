import { describe, expect, it } from "vitest";
import { FrameSchema } from "./index.js";

describe("MVP protocol frames", () => {
  it("accepts both success and error responses without duplicate discriminator failures", () => {
    expect(FrameSchema.parse({ type: "response", id: "1", ok: true, payload: {} })).toMatchObject({ ok: true });
    expect(FrameSchema.parse({ type: "response", id: "2", ok: false, error: { code: "X", message: "bad" } })).toMatchObject({ ok: false });
  });
});


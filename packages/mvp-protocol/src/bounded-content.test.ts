import { describe, expect, it } from "vitest";
import { ContentChunkRequestSchema, ContentChunkSchema, ContentRefSchema } from "./bounded-content.js";
const ref = { ref: `cnt_${"a".repeat(32)}`, bytes: 4, sha256: "b".repeat(64), format: "text/plain" };
describe("bounded content protocol", () => {
  it("accepts opaque references and strict byte-range requests", () => {
    expect(ContentRefSchema.parse(ref)).toEqual(ref);
    expect(ContentChunkRequestSchema.parse({ sessionId: "s", ref: ref.ref })).toMatchObject({ offset: 0, maxBytes: 64 * 1024, encoding: "utf8" });
    for (const value of [{ sessionId: "s", ref: "/etc/passwd" }, { sessionId: "s", ref: ref.ref, path: "/etc/passwd" }, { sessionId: "s", ref: ref.ref, offset: 0.5 }, { sessionId: "s", ref: ref.ref, maxBytes: 256 * 1024 }]) expect(ContentChunkRequestSchema.safeParse(value).success).toBe(false);
  });
  it("verifies decoded byte lengths, progress and explicit encoding", () => {
    const chunk = { sessionId: "s", ref: ref.ref, offset: 0, nextOffset: 4, totalBytes: 4, sha256: ref.sha256, format: ref.format, hasMore: false, encoding: "utf8", text: "🚀" };
    expect(ContentChunkSchema.safeParse(chunk).success).toBe(true);
    expect(ContentChunkSchema.safeParse({ ...chunk, nextOffset: 1, totalBytes: 1 }).success).toBe(false);
    expect(ContentChunkSchema.safeParse({ ...chunk, nextOffset: 0, hasMore: true, text: "" }).success).toBe(false);
    const { text, ...common } = chunk;
    expect(ContentChunkSchema.safeParse({ ...common, encoding: "base64", data: "8J+agA==" }).success).toBe(true);
    expect(ContentChunkSchema.safeParse({ ...common, encoding: "base64", data: "not-base64" }).success).toBe(false);
  });
});

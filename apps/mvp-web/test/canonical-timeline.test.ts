import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectedItem } from "@flyx/mvp-protocol";
import { canonicalTimelineItem } from "../src/canonical-timeline.js";

const reference = { ref: `cnt_${"a".repeat(32)}`, bytes: 1024, sha256: "b".repeat(64), format: "text/plain" };
const item: ProjectedItem = { sessionId: "session-a", itemId: "reply", kind: "assistant_message", status: "completed", displaySequence: 1, revision: 10, content: reference, contentField: "text", metadata: { turnId: "turn-a" }, updatedAt: "now" };
test("canonical body references remain visible with a loading control target", () => {
  const projected = canonicalTimelineItem(item); const content = projected.content as Record<string, unknown>;
  assert.match(String(content.text), /1024 bytes/); assert.deepEqual(content.contentRef, reference); assert.equal(content.turnId, "turn-a"); assert.equal(projected.revision, 10);
});
test("verified full content replaces the preview and preserves reference metadata", () => {
  const content = canonicalTimelineItem(item, { text: "Full answer", turnId: "turn-a" }).content as Record<string, unknown>;
  assert.equal(content.text, "Full answer"); assert.equal(content.contentLoaded, true); assert.deepEqual(content.contentRef, reference);
});
test("canonical inline items keep their full body without a raw delta append", () => {
  const content = canonicalTimelineItem({ ...item, content: { inline: { text: "Hello world" } } }).content as Record<string, unknown>;
  assert.equal(content.text, "Hello world"); assert.equal(content.turnId, "turn-a");
});

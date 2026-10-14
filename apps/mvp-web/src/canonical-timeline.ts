import type { ProjectedItem, TimelineItem } from "@flyx/mvp-protocol";
import { isRecord } from "./timeline.js";

/** Body refs retain a visible preview and explicit loading metadata. */
export function canonicalTimelineItem(item: ProjectedItem, resolved?: unknown): TimelineItem {
  const inline = "inline" in item.content ? item.content.inline : undefined;
  const value = resolved !== undefined ? resolved : inline;
  const content: Record<string, unknown> = { ...item.metadata, ...(isRecord(value) ? value : value !== undefined ? { value } : {}) };
  if (!("inline" in item.content)) {
    content.contentRef = item.content;
    content.contentField = item.contentField;
    if (resolved === undefined) {
      const field = item.contentField ?? "message";
      if (typeof content[field] !== "string" || !content[field]) content[field] = `[内容按需加载：${item.content.bytes} bytes]`;
    } else content.contentLoaded = true;
  }
  if (resolved !== undefined) content.contentLoaded = true;
  if (item.metadataRef) content.metadataRef = item.metadataRef;
  if (item.sourceSeqRangesRef) content.sourceSeqRangesRef = item.sourceSeqRangesRef;
  if (item.kind === "question") content.projectionKind = "question";
  return { sessionId: item.sessionId, itemId: item.itemId, kind: item.kind === "question" ? "system" : item.kind, status: item.status, revision: item.revision, content, updatedAt: item.updatedAt };
}

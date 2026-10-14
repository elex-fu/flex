import type Database from "better-sqlite3";
import type { SessionEvent } from "@flyx/mvp-protocol";
import type { TimelineContentReference } from "@flyx/mvp-protocol";

export type ContentReference = TimelineContentReference;
export interface TimelineContentStore {
  pin(input: { sessionId: string; ref: string; ownerKind: "query" | "timeline"; ownerId: string; expiresAt?: string }): string;
  beginStream(input: { sessionId: string; itemId: string; format: string; workspace: string }): { streamId: string };
  appendSegment(input: { streamId: string; sourceSequence: number; text: string }): ContentReference;
  finalizeStream(input: { streamId: string; sourceSequence: number }): ContentReference;
  putBlob(input: { sessionId: string; itemId?: string; format: string; text: string; workspace: string }): ContentReference;
}
export type CommitBoundary = { id: string; sessionId: string; firstSequence: number; lastSequence: number };
export interface TimelineCommitStore {
  readonly db: Database.Database;
  registerCommitHook(hook: (events: readonly SessionEvent[], commit: CommitBoundary) => void): () => void;
}
export type TimelineLeaseOwner = { subjectId: string; leaseId: string; generation: number };
export type TimelinePageBudget = { fits(payload: unknown): boolean };
export class JsonTimelineBudget implements TimelinePageBudget {
  constructor(readonly maximumBytes = 192 * 1024, private readonly envelope: (payload: unknown) => unknown = (payload) => payload) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 || maximumBytes > 256 * 1024) throw new RangeError("Invalid timeline budget");
  }
  fits(payload: unknown): boolean { return Buffer.byteLength(JSON.stringify(this.envelope(payload)), "utf8") <= this.maximumBytes; }
}
export class TimelineError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = "TimelineError"; }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function inTransaction<T>(db: Database.Database, action: () => T): T {
  return db.inTransaction ? action() : db.transaction(action)();
}

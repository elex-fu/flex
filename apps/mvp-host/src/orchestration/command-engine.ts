import { createHash, randomUUID } from "node:crypto";
import type { SessionEvent } from "@flyx/mvp-protocol";
import type { SqliteStore } from "../storage/db.js";
import { assertReceiptRequest, type CommandCommit, type CommandFacts, type CommandPlan, type CommandRequest, type DecisionClock } from "./command-contract.js";

export type CommandEngineOptions = {
  clock?: DecisionClock;
  admission?: (request: CommandRequest, facts: CommandFacts) => void;
  publish?: (event: SessionEvent) => void;
  wake?: () => void;
};

/** Only commits synchronous decisions. Native work is owned by the durable intent consumer. */
export class CommandEngine {
  private readonly clock: DecisionClock;
  constructor(readonly store: SqliteStore, private readonly options: CommandEngineOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date().toISOString(), id: randomUUID };
  }

  commitRequest<T>(request: CommandRequest, decide: (facts: CommandFacts, clock: DecisionClock) => CommandPlan<T>,
    options: { approvalId?: string; expectedRevision?: number } = {}): CommandCommit<T> {
    if (!request.commandId) throw new Error("COMMAND_ID_REQUIRED");
    let reused = false;
    const committed = this.store.commitCommand({
      ...(request.targetSessionId ? { sessionId: request.targetSessionId } : {}),
      ...options,
      occurredAt: this.clock.now(), commitId: this.clock.id(),
      build: (facts) => {
        // Admission precedes receipt reuse: revocation never becomes an idempotency bypass.
        this.options.admission?.(request, facts);
        const existing = this.store.getCommandReceipt(request.authSubjectId, request.commandId);
        if (existing) {
          assertReceiptRequest(existing, request);
          reused = true;
          return { result: existing.response as T };
        }
        return decide(facts, this.clock);
      },
    });
    if (!committed) throw new Error("COMMAND_NOT_COMMITTED");
    committed.reused = reused;
    for (const event of committed.events) {
      try { this.options.publish?.(event); } catch { /* Facts are already durable; replay repairs delivery. */ }
    }
    if (committed.intents.length) {
      try { this.options.wake?.(); } catch { /* Pending intents remain discoverable by scanning. */ }
    }
    return committed;
  }
}

/** The original normalized payload hash is retained verbatim for legacy requests. */
export function hashCommandRequest(method: string, payload: unknown,
  resource?: { requestFormatVersion: 2; targetSessionId: string; workspaceId?: string }): string {
  const value = resource ? { method, payload: canonicalize(payload), resource: canonicalize(resource) }
    : { method, payload: canonicalize(payload) };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

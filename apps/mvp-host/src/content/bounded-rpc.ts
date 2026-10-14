import { publicValue } from "../api/public-projection.js";
import { ContentStore } from "./content-store.js";
import { FrameBudget, FrameBudgetError, utf8Prefix } from "./frame-budget.js";

export interface BoundRpcOptions {
  allowRefs: boolean;
  method?: string;
  subjectId?: string;
  pinOwner?: string;
}

/** Bounds already public business values while retaining the legacy preview fields. */
export class BoundedRpcProjection {
  constructor(private readonly sessionId: string, private readonly workspace: string, private readonly content?: ContentStore) {}

  bound(value: unknown, budget: FrameBudget, envelope: (payload: unknown) => unknown, options: BoundRpcOptions): unknown {
    const projected = publicValue(value, this.workspace);
    if (budget.fits(envelope(projected))) return projected;
    const originalBytes = budget.bytes(projected);
    const allowRefs = options.allowRefs && this.content !== undefined;
    const marker = { truncated: true as const, requiresUpgrade: !allowRefs, originalBytes };
    const scope = options.method?.startsWith("access.") ? "access:admin" : "session:read";
    const subjectId = options.method === "command.getReceipt" ? options.subjectId : undefined;
    const put = (text: string, format: string) => {
      const ref = this.content!.putBlob({ sessionId: this.sessionId, format, text, workspace: this.workspace, requiredScope: scope, ...(subjectId ? { subjectId } : {}) });
      if (options.pinOwner) this.content!.pin({ sessionId: this.sessionId, ref: ref.ref, ownerKind: "query", ownerId: options.pinOwner, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      return ref;
    };
    const reduce = (item: unknown): unknown => {
      if (typeof item === "string") {
        if (Buffer.byteLength(item) <= 8 * 1024) return item;
        return { preview: utf8Prefix(item, 2 * 1024), ...(allowRefs ? { contentRef: put(item, "text/plain") } : {}), boundedContent: marker };
      }
      if (Array.isArray(item)) return item.map(reduce);
      if (!item || typeof item !== "object") return item;
      const result: Record<string, unknown> = {};
      let truncated = false;
      for (const [key, child] of Object.entries(item)) {
        if (typeof child === "string" && Buffer.byteLength(child) > 8 * 1024) {
          result[key] = utf8Prefix(child, 2 * 1024);
          result[`${key}Truncated`] = true;
          if (allowRefs) result[`${key}Ref`] = put(child, "text/plain");
          truncated = true;
        } else result[key] = reduce(child);
      }
      if (truncated) result.boundedContent = marker;
      return result;
    };
    const run = () => {
      const reduced = reduce(projected);
      if (budget.fits(envelope(reduced))) return reduced;
      // The old cursor can advance only through events that fit in this page.
      if (options.method === "session.getEvents" && record(reduced) && Array.isArray(reduced.events)) {
        const events = reduced.events;
        let low = 0;
        let high = events.length;
        const page = (count: number) => ({ ...reduced, events: events.slice(0, count), ...(count > 0 && record(events[count - 1]) ? { nextAfter: events[count - 1]!.sequence, hasMore: Number(events[count - 1]!.sequence) < Number(reduced.upTo) } : { hasMore: true }) });
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (budget.fits(envelope(page(middle)))) low = middle;
          else high = middle - 1;
        }
        if (low > 0) return page(low);
        if (events.length && record(events[0]) && record(projected) && Array.isArray(projected.events) && record(projected.events[0])) {
          const original = projected.events[0];
          const body = { boundedContent: marker, ...(allowRefs ? { payloadRef: put(JSON.stringify(original.payload), "application/json") } : {}) };
          const first = { ...events[0], payload: body };
          const sequence = Number(events[0].sequence);
          const result = { ...reduced, events: [first], nextAfter: sequence, hasMore: sequence < Number(reduced.upTo) };
          budget.assert(envelope(result));
          return result;
        }
      }
      if (allowRefs) {
        const result = { boundedContent: marker, payloadRef: put(JSON.stringify(projected), "application/json") };
        budget.assert(envelope(result));
        return result;
      }
      // Explicit upgrade state replaces a large metadata directory, rather than pretending it is complete.
      const summary = { boundedContent: marker };
      if (!budget.fits(envelope(summary))) throw new FrameBudgetError();
      return summary;
    };
    return this.content && allowRefs ? this.content.db.transaction(run)() : run();
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

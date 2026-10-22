import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";

export type Snapshot = {
  session: {
    id: string;
    provider: Bootstrap["provider"];
    activityState: string;
    headSequence: number;
    providerSessionId?: string;
    status?: "active" | "archived";
    residency?: "unloaded" | "loading" | "loaded" | "closing" | "blocked";
    title?: string;
  };
  // Keep the optional field explicitly undefined-able because the live
  // projection removes an active turn as soon as a terminal event arrives.
  activeTurn?: { id: string; status: string; prompt: string } | undefined;
  pendingApprovals: Array<{
    approvalId: string;
    toolUseId: string;
    request: Record<string, unknown>;
    version: number;
  }>;
};

type JsonRecord = Record<string, unknown>;

/**
 * The server sends a canonical event payload, not a TimelineItem snapshot.
 * Keep this projection deliberately small and deterministic: replaying the
 * same event range after a refresh must produce exactly the same item IDs and
 * content as the live stream.
 */
function eventPayload(event: SessionEvent): JsonRecord {
  return isRecord(event.payload) ? event.payload : { value: event.payload };
}

function eventItemKind(event: SessionEvent): TimelineItem["kind"] {
  if (event.type.startsWith("user.")) return "user_message";
  if (event.type.startsWith("assistant.")) return "assistant_message";
  if (event.type.startsWith("tool.")) return "tool_call";
  if (event.type === "turn.failed" || event.type === "session.recovery.required" || event.type.endsWith(".failed") || event.type.endsWith(".unavailable") || event.type.includes("persist_failed")) return "error";
  if (event.type === "turn.reconciled" && isRecord(eventPayload(event).outcome)) {
    const outcome = eventPayload(event).outcome;
    const status = isRecord(outcome) && typeof outcome.status === "string" ? outcome.status : undefined;
    if (status === "failed" || status === "outcome_unknown") return "error";
  }
  if (event.type.startsWith("approval.")) return "approval";
  return "system";
}

function eventStatus(event: SessionEvent, payload: JsonRecord): string {
  if (typeof payload.status === "string") return payload.status;
  if (event.type === "provider.session.init") return "info";
  if (event.type === "assistant.message.delta") return "streaming";
  if (event.type === "assistant.message.completed" && payload.aborted === true) return "aborted";
  if (event.type === "turn.interrupt.requested") return "requested";
  if (event.type === "turn.interrupt.unavailable" || event.type.endsWith(".unavailable")) return "error";
  if (event.type === "turn.completed") return "completed";
  if (event.type === "turn.cancelled") return "cancelled";
  if (event.type === "turn.failed") return "failed";
  if (event.type === "turn.reconciled" && isRecord(payload.outcome) && typeof payload.outcome.status === "string") return payload.outcome.status;
  return event.type.split(".").at(-1) ?? event.type;
}

function shouldRenderEventWithoutItem(event: SessionEvent): boolean {
  return event.type === "provider.session.init"
    || event.type === "turn.interrupt.requested"
    || event.type === "turn.interrupt.unavailable"
    || event.type === "approval.resolve.unavailable"
    || event.type === "turn.reconciled"
    || event.type === "session.recovery.required"
    || event.type === "host.event_persist_failed"
    || event.type === "diagnostic";
}

export function timelineItemFromEvent(event: SessionEvent, existing?: TimelineItem): TimelineItem | undefined {
  const payload = eventPayload(event);
  const explicitItemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
  if (!explicitItemId && !shouldRenderEventWithoutItem(event)) return undefined;
  const itemId = explicitItemId ?? `event-${event.id}`;
  const kind = eventItemKind(event);
  const previousContent = isRecord(existing?.content) ? existing.content : {};
  // Event deltas contain only the next fragment; stored TimelineItems contain
  // the accumulated body. Completion replaces that body with the final text.
  // Tool progress contains accumulated output and remains a metadata merge.
  const content: JsonRecord = {
    ...previousContent,
    ...payload,
    eventType: event.type,
    ...(explicitItemId ? {} : { message: payload.message ?? event.type }),
  };
  if (typeof payload.result === "string" && typeof payload.message !== "string") content.message = payload.result;
  if (event.type === "turn.cancelled" && typeof payload.reason === "string") content.message = `Turn cancelled: ${payload.reason}`;
  if (kind === "assistant_message" && typeof payload.text === "string") {
    const previousText = typeof previousContent.text === "string" ? previousContent.text : "";
    content.text = event.type === "assistant.message.delta" ? previousText + payload.text : payload.text;
  }
  return {
    sessionId: event.sessionId,
    itemId,
    kind,
    status: eventStatus(event, payload),
    revision: existing ? existing.revision + 1 : 0,
    content,
    updatedAt: event.occurredAt,
  };
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasTerminalItem(items: TimelineItem[], turnId: string): boolean {
  return items.some((item) => {
    const content = isRecord(item.content) ? item.content : undefined;
    if (content?.turnId !== turnId) return false;
    if (content.eventType === "turn.completed" || content.eventType === "turn.failed" || content.eventType === "turn.cancelled") return true;
    if (content.eventType !== "turn.reconciled") return false;
    const outcome = isRecord(content.outcome) ? content.outcome : undefined;
    return Boolean(outcome && typeof outcome.status === "string" && ["completed", "failed", "cancelled", "outcome_unknown"].includes(outcome.status));
  });
}

function approvalFromEvent(event: SessionEvent): Snapshot["pendingApprovals"][number] | undefined {
  const payload = eventPayload(event);
  if (typeof payload.approvalId !== "string" || typeof payload.toolUseId !== "string") return undefined;
  return {
    approvalId: payload.approvalId,
    toolUseId: payload.toolUseId,
    request: payload,
    version: typeof payload.version === "number" ? payload.version : 0,
  };
}

export function projectSnapshot(snapshot: Snapshot | null, event: SessionEvent, items: TimelineItem[]): Snapshot | null {
  if (!snapshot) return snapshot;
  const payload = eventPayload(event);
  const turnId = typeof payload.turnId === "string" ? payload.turnId : snapshot.activeTurn?.id;
  const next: Snapshot = {
    ...snapshot,
    // The authenticated snapshot may report a newer head than the historical
    // page currently being replayed. Never make the UI cursor move backwards
    // while catch-up is applying that page.
    session: { ...snapshot.session, headSequence: Math.max(snapshot.session.headSequence, event.sequence) },
    pendingApprovals: snapshot.pendingApprovals.slice(),
  };
  const ensureTurn = (status: string, prompt?: string) => {
    if (!turnId) return;
    next.activeTurn = {
      id: turnId,
      status,
      prompt: prompt ?? (next.activeTurn?.id === turnId ? next.activeTurn.prompt : ""),
    };
  };

  if (event.type === "provider.session.init" && typeof payload.providerSessionId === "string") {
    next.session.providerSessionId = payload.providerSessionId;
  }
  switch (event.type) {
    case "user.message.created":
      ensureTurn("queued", typeof payload.text === "string" ? payload.text : undefined);
      next.session.activityState = "running";
      break;
    case "turn.requested":
      ensureTurn("queued");
      next.session.activityState = "running";
      break;
    case "turn.started":
      ensureTurn("running");
      next.session.activityState = "running";
      break;
    case "approval.requested": {
      ensureTurn("waiting_approval");
      next.session.activityState = "waiting_approval";
      const approval = approvalFromEvent(event);
      if (approval && !next.pendingApprovals.some((item) => item.approvalId === approval.approvalId)) {
        next.pendingApprovals.push(approval);
      }
      break;
    }
    case "approval.resolved": {
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
      if (approvalId) next.pendingApprovals = next.pendingApprovals.filter((item) => item.approvalId !== approvalId);
      const pendingForTurn = items.some((item) => item.kind === "approval" && item.status === "pending" && (!turnId || item.content && isRecord(item.content) && item.content.turnId === turnId));
      ensureTurn(pendingForTurn ? "waiting_approval" : "running");
      next.session.activityState = pendingForTurn ? "waiting_approval" : "running";
      break;
    }
    case "approval.resolve.unavailable":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "session.recovery.required":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "turn.interrupt.requested":
      ensureTurn("interrupting");
      next.session.activityState = "interrupting";
      break;
    case "turn.interrupt.unavailable":
    case "host.event_persist_failed":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "turn.reconciled": {
      const outcome = isRecord(payload.outcome) ? payload.outcome : undefined;
      const outcomeStatus = outcome && typeof outcome.status === "string" ? outcome.status : undefined;
      if (outcomeStatus === "outcome_unknown") {
        ensureTurn("outcome_unknown");
        next.session.activityState = "outcome_unknown";
      } else if (outcomeStatus === "completed" || outcomeStatus === "failed" || outcomeStatus === "cancelled") {
        next.activeTurn = undefined;
        next.session.activityState = "idle";
        next.pendingApprovals = next.pendingApprovals.filter((item) => item.request.turnId !== turnId);
      }
      break;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
      next.activeTurn = undefined;
      next.session.activityState = "idle";
      next.pendingApprovals = next.pendingApprovals.filter((item) => item.request.turnId !== turnId);
      break;
    default:
      break;
  }
  return next;
}


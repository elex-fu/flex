import { ClientError, SessionClient } from "@flyx/client-core";
import type { DraftCommandOptions, DraftKey, FlyxClient, SessionClientPort } from "@flyx/client-core";
import { SESSION_CATALOG_CAPABILITY, SessionSnapshotV2Schema, StartTurnV2Schema } from "@flyx/mvp-protocol";
import { z } from "zod";

const legacySnapshot = z.object({
  session: z.object({ id: z.string().min(1), activityState: z.string() }).passthrough(),
  activeTurn: z.object({ id: z.string().min(1), sessionId: z.string().min(1).optional() }).passthrough().nullable().optional(),
}).passthrough();
/** The negotiated catalog uses its full public DTO. The explicit legacy facade
 * keeps id; neither supplies authority for another selected Session or Turn. */
function selectedSnapshot(value: unknown, expectedSessionId: string) {
  const scoped = z.object({ session: z.record(z.string(), z.unknown()) }).passthrough().parse(value);
  const parsed = Object.hasOwn(scoped.session, "sessionId") ? SessionSnapshotV2Schema.parse(value) : legacySnapshot.parse(value);
  const sessionId = "sessionId" in parsed.session ? parsed.session.sessionId : parsed.session.id;
  if (sessionId !== expectedSessionId || parsed.activeTurn?.sessionId !== undefined && parsed.activeTurn.sessionId !== expectedSessionId) throw new ClientError("SESSION_SNAPSHOT_MISMATCH", "Snapshot or Turn belongs to another Session");
  return parsed;
}
export function readSessionSnapshot(value: unknown, expectedSessionId: string) {
  const parsed = selectedSnapshot(value, expectedSessionId);
  return { sessionId: expectedSessionId, activityState: parsed.session.activityState, ...(parsed.activeTurn ? { activeTurnId: parsed.activeTurn.id } : {}) };
}
export function sessionIsIdle(value: unknown, expectedSessionId?: string): boolean {
  if (!expectedSessionId) return false;
  try { return readSessionSnapshot(value, expectedSessionId).activityState === "idle"; } catch { return false; }
}
/** Idle history alone cannot authorize a task while recovery/runtime closure is
 * gated. A new unloaded Session may legitimately acquire its first runtime. */
export function sessionCanCompose(value: unknown, expectedSessionId?: string): boolean {
  if (!expectedSessionId) return false;
  try {
    const parsed = selectedSnapshot(value, expectedSessionId);
    if (parsed.session.activityState !== "idle") return false;
    if (parsed.activeTurn && !["completed", "failed", "cancelled"].includes(String(parsed.activeTurn.status))) return false;
    if (parsed.session.status !== undefined && parsed.session.status !== "active") return false;
    return !["blocked", "closing"].includes(String(parsed.session.residency));
  } catch { return false; }
}
export function nativeSessionClient(client: SessionClientPort): SessionClient {
  return new SessionClient(client, { commandId: () => crypto.randomUUID() });
}
type DraftSessionPort = Pick<FlyxClient, "supportsCapability" | "request" | "commandFromDraft">;
/** Typed catalog execution keeps the same atomic SQL command/draft handoff.
 * Validation and negotiated gating happen before persistence can clear a draft. */
export async function sendTaskFromDraft(client: DraftSessionPort, input: unknown, key: DraftKey, options: DraftCommandOptions): Promise<unknown> {
  const payload = StartTurnV2Schema.parse(input);
  if (payload.sessionId !== key.sessionId) throw new ClientError("DRAFT_SESSION_MISMATCH", "Command targets another draft Session");
  if (!client.supportsCapability(SESSION_CATALOG_CAPABILITY)) return client.commandFromDraft("session.startTurn", payload, key, options);
  const service = new SessionClient({
    supportsCapability: (name) => client.supportsCapability(name),
    request: <T>(method: string, value?: unknown) => client.request<T>(method, value),
    command: <T>(method: string, value?: unknown, commandId?: string) => client.commandFromDraft<T>(method, value, key, { ...options, ...(commandId !== undefined ? { commandId } : {}) }),
  }, { commandId: () => crypto.randomUUID() });
  return service.startTurn(payload, options.commandId);
}

import { z } from "zod";
const identity = z.object({ id: z.string().min(1).optional(), sessionId: z.string().min(1).optional(), activityState: z.string() }).passthrough().refine((value) => !!(value.sessionId ?? value.id) && !(value.sessionId && value.id && value.sessionId !== value.id), "Session identity is missing or ambiguous");
const snapshot = z.object({ session: identity, activeTurn: z.object({ id: z.string().min(1) }).passthrough().nullable().optional() }).passthrough();
/** R11 uses sessionId; the explicit legacy facade still uses id. Neither may
 * silently select another Session or supply authority from cached content. */
export function readSessionSnapshot(value: unknown, expectedSessionId: string) {
  const parsed = snapshot.parse(value), sessionId = parsed.session.sessionId ?? parsed.session.id!;
  if (sessionId !== expectedSessionId) throw new Error("SESSION_SNAPSHOT_MISMATCH");
  return { sessionId, activityState: parsed.session.activityState, ...(parsed.activeTurn ? { activeTurnId: parsed.activeTurn.id } : {}) };
}
export function sessionIsIdle(value: unknown, expectedSessionId?: string): boolean {
  if (!expectedSessionId) return false;
  try { return readSessionSnapshot(value, expectedSessionId).activityState === "idle"; } catch { return false; }
}

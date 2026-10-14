import { AttentionRouteSchema, type AttentionRoute } from "@flyx/mvp-protocol";
export type AttentionSessionState = {
  id: string;
  activeTurnId?: string;
};
export type AttentionInteractionState = {
  interactionId: string;
  sessionId: string;
  turnId: string;
  version: number;
  status: string;
  expiresAt: string;
  responseAvailable: boolean;
};
export interface AttentionRouteLoader {
  getSession(hostId: string, sessionId: string): Promise<AttentionSessionState>;
  getInteraction(hostId: string, sessionId: string, interactionId: string): Promise<AttentionInteractionState | undefined>;
}
export type AttentionRouteResolution = {
  status: "ready" | "stale" | "expired";
  route: AttentionRoute;
  session: AttentionSessionState;
  interaction?: AttentionInteractionState;
};
/** Fetch current authorized facts even for expired routes. This helper has no response action. */
export async function revalidateAttentionRoute(value: unknown, loader: AttentionRouteLoader, now: () => Date = () => new Date()): Promise<AttentionRouteResolution> {
  const route = AttentionRouteSchema.parse(value);
  const session = await loader.getSession(route.hostId, route.sessionId);
  if (session.id !== route.sessionId)
    throw new Error("ATTENTION_SESSION_MISMATCH");
  const interaction = route.interactionId ? await loader.getInteraction(route.hostId, route.sessionId, route.interactionId) : undefined;
  let status: AttentionRouteResolution["status"] = "ready";
  if (Date.parse(route.expiresAt) <= now().getTime())
    status = "expired";
  else if (route.turnId && session.activeTurnId && session.activeTurnId !== route.turnId)
    status = "stale";
  else if (route.interactionId && (!interaction || interaction.interactionId !== route.interactionId || interaction.sessionId !== route.sessionId
    || interaction.turnId !== route.turnId || interaction.version !== route.version || interaction.status !== "pending"
    || !interaction.responseAvailable || Date.parse(interaction.expiresAt) <= now().getTime()))
    status = "stale";
  return { status, route, session, ...(interaction ? { interaction } : {}) };
}

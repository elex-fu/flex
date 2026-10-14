import { ClientError } from "@flyx/client-core";
import type { FlyxClient } from "@flyx/client-core";
import { InteractionSchema, InteractionRespondApprovalRequestSchema, QuestionRespondRequestSchema, validateQuestionAnswers } from "@flyx/mvp-protocol";
import type { Interaction, QuestionAnswers } from "@flyx/mvp-protocol";
export function interactionAvailable(client: FlyxClient, interaction: Interaction, scopes: string[]): boolean {
  const state = client.getState(), replica = client.replica.getState();
  return state.connection === "online" && replica.sync === "synced" && !replica.stale && replica.interactionsAuthoritative && replica.sessionId === interaction.sessionId && scopes.includes("approval:write") && interaction.status === "pending" && interaction.responseAvailable && Date.parse(interaction.expiresAt) > Date.now();
}
export async function respondInteraction(client: FlyxClient, shown: Interaction, scopes: string[], response: "allow_once" | "deny" | QuestionAnswers): Promise<void> {
  if (!interactionAvailable(client, shown, scopes)) throw new ClientError("INTERACTION_STALE", "Refresh this interaction before responding");
  const fence = client.replica.currentFence();
  const current = InteractionSchema.parse(await client.request("interaction.get", { sessionId: shown.sessionId, interactionId: shown.interactionId }));
  if (!fence || !client.replica.isCurrent(fence) || current.interactionId !== shown.interactionId || current.sessionId !== shown.sessionId || current.turnId !== shown.turnId || current.kind !== shown.kind || current.version !== shown.version || !interactionAvailable(client, current, scopes)) throw new ClientError("INTERACTION_STALE", "This interaction has changed");
  if (current.kind === "approval") {
    if (typeof response !== "string" || !current.allowedActions.includes(response)) throw new ClientError("INVALID_RESPONSE", "This approval action is not available");
    await client.command("interaction.respondApproval", InteractionRespondApprovalRequestSchema.parse({ sessionId: current.sessionId, interactionId: current.interactionId, expectedVersion: current.version, action: response }));
  } else {
    if (typeof response === "string") throw new ClientError("INVALID_RESPONSE", "Answer the current question");
    const answers = validateQuestionAnswers(current.request, response);
    await client.command("question.respond", QuestionRespondRequestSchema.parse({ sessionId: current.sessionId, interactionId: current.interactionId, expectedVersion: current.version, answers }));
  }
}

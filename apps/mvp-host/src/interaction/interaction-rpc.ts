import { ZodError } from "zod";
import { InteractionGetRequestSchema, InteractionListRequestSchema } from "@flyx/mvp-protocol";
import type { InteractionService } from "./interaction-service.js";
export const INTERACTION_RPC_SCOPES = {
  "interaction.get": "session:read", "interaction.list": "session:read", "interaction.respondApproval": "approval:write", "question.respond": "approval:write",
} as const;
export class InteractionRpcError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = "InteractionRpcError"; }
}
/** Dispatcher authenticates/scopes reads; response admission also checks the durable Device. */
export function interactionRpc(service: InteractionService, method: keyof typeof INTERACTION_RPC_SCOPES, payload: unknown, actor?: {
  authSubjectId: string;
  commandId: string;
}): unknown {
  try {
    if (!Object.hasOwn(INTERACTION_RPC_SCOPES, method))
      throw new InteractionRpcError("METHOD_NOT_FOUND");
    if (method === "interaction.get") {
      const input = InteractionGetRequestSchema.parse(payload);
      return service.get(input.sessionId, input.interactionId);
    }
    if (method === "interaction.list") {
      const input = InteractionListRequestSchema.parse(payload);
      return service.list(input.sessionId, input.afterInteractionId);
    }
    if (!actor)
      throw new InteractionRpcError("DEVICE_AUTH_REQUIRED");
    return method === "question.respond" ? service.respondQuestion(actor.authSubjectId, actor.commandId, payload)
      : service.respondApproval(actor.authSubjectId, actor.commandId, payload);
  }
  catch (error) {
    if (error instanceof InteractionRpcError)
      throw error;
    if (error instanceof ZodError)
      throw new InteractionRpcError("INVALID_PARAMS");
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.message) ? error.message : "INTERACTION_FAILED";
    throw new InteractionRpcError(code, ["INTERACTION_VERSION_CONFLICT", "INTERACTION_RESPONDING"].includes(code));
  }
}

import { z } from "zod";
export const ATTENTION_MAX_PAYLOAD_BYTES = 1536;
export const ATTENTION_MAX_PAGE_BYTES = 24 * 1024;
const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
export const AttentionKindSchema = z.enum(["question", "approval", "completion", "recovery_blocked"]);
export type AttentionKind = z.infer<typeof AttentionKindSchema>;
export const AttentionRouteSchema = z.object({
  v: z.literal(1), hostId: id, attentionId: id, sessionId: id,
  turnId: id.optional(), interactionId: id.optional(), version: revision,
  expiresAt: z.string().datetime({ offset: true }),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= ATTENTION_MAX_PAYLOAD_BYTES, "Attention route exceeds encoded budget");
export type AttentionRoute = z.infer<typeof AttentionRouteSchema>;
export const AttentionDeliveryStateSchema = z.enum(["none", "pending", "dispatching", "accepted", "provider_delivered", "presented", "unavailable", "outcome_unknown", "cancelled", "expired"]);
export type AttentionDeliveryState = z.infer<typeof AttentionDeliveryStateSchema>;
export const AttentionSummarySchema = AttentionRouteSchema.safeExtend({
  kind: AttentionKindSchema, createdAt: z.string().datetime({ offset: true }),
  acknowledged: z.boolean(), stale: z.boolean(), deliveryState: AttentionDeliveryStateSchema,
});
export type AttentionSummary = z.infer<typeof AttentionSummarySchema>;
export const AttentionListRequestSchema = z.object({
  sessionId: id.optional(), after: revision.default(0), limit: z.number().int().min(1).max(50).default(25),
  includeAcknowledged: z.boolean().default(false),
}).strict();
export const AttentionListResponseSchema = z.object({
  items: z.array(AttentionSummarySchema).max(50), nextAfter: revision, hasMore: z.boolean(), unavailable: z.boolean(),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= ATTENTION_MAX_PAGE_BYTES);
export type AttentionListResponse = z.infer<typeof AttentionListResponseSchema>;
export const AttentionAcknowledgeRequestSchema = z.object({ attentionId: id, expectedVersion: revision }).strict();
export const AttentionAcknowledgeResponseSchema = z.object({ attentionId: id, version: revision, acknowledged: z.literal(true), stale: z.boolean() }).strict();
export const ExpoPushTokenSchema = z.string().regex(/^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{1,200}\]$/).max(256);
export const AttentionRegisterPushRequestSchema = z.object({
  platform: z.literal("expo"), tokenType: z.literal("expo"), token: ExpoPushTokenSchema,
  projectId: z.string().uuid(), expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type AttentionRegisterPushRequest = z.infer<typeof AttentionRegisterPushRequestSchema>;
export const AttentionSubscriptionSchema = z.object({
  subscriptionId: id, platform: z.literal("expo"), projectId: z.string().uuid(),
  status: z.enum(["active", "revoked", "expired"]), expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const AttentionUnregisterPushRequestSchema = z.object({ subscriptionId: id }).strict();
export const AttentionPreferencesSchema = z.object({ mode: z.enum(["all", "interactions", "none"]), pushEnabled: z.boolean(), revision }).strict();
export type AttentionPreferences = z.infer<typeof AttentionPreferencesSchema>;
export const AttentionSetPreferencesRequestSchema = AttentionPreferencesSchema.omit({ revision: true }).extend({ expectedRevision: revision }).strict();
export const AttentionPresenceRequestSchema = z.object({ foreground: z.boolean(), sessionId: id.optional() }).strict();
export const AttentionCapability = "attention-v1" as const;
export const AttentionMethodScopes = Object.freeze({
  "attention.registerPush": "access:self", "attention.unregisterPush": "access:self", "attention.list": "session:read",
  "attention.acknowledge": "access:self", "attention.getPreferences": "access:self", "attention.setPreferences": "access:self",
  "attention.setPresence": "access:self",
} as const);

import { z } from "zod";

const CatalogId = z.string().min(1).max(256);
const Provider = z.enum(["claude", "codex"]);
const Activity = z.enum(["idle", "running", "waiting_approval", "interrupting", "outcome_unknown", "runtime_unavailable"]);
export const SessionResidencySchema = z.enum(["unloaded", "loading", "loaded", "closing", "blocked"]);
export type SessionResidency = z.infer<typeof SessionResidencySchema>;

export const SessionSummaryV2Schema = z.strictObject({
  sessionId: CatalogId, workspaceId: CatalogId, providerInstanceId: CatalogId, provider: Provider,
  title: z.string().max(256), status: z.enum(["active", "archived"]), activityState: Activity,
  headSequence: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  residency: SessionResidencySchema, nativeSessionAvailable: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type SessionSummaryV2 = z.infer<typeof SessionSummaryV2Schema>;

/** Private persistence contract. SessionSummaryV2 only advertises presence. */
export const SessionNativeHandleSchema = z.strictObject({
  v: z.literal(1), provider: Provider, providerInstanceId: CatalogId, workspaceId: CatalogId,
  nativeSessionId: z.string().min(1).max(1024), provenance: z.enum(["legacy", "native"]),
});
export type SessionNativeHandle = z.infer<typeof SessionNativeHandleSchema>;

export const SessionTargetV2Schema = z.strictObject({ sessionId: CatalogId });
export const CreateSessionV2Schema = z.strictObject({
  workspaceId: CatalogId, providerInstanceId: CatalogId, title: z.string().max(256).default("Untitled session"),
});
export const RenameSessionV2Schema = z.strictObject({ sessionId: CatalogId, expectedRevision: z.number().int().nonnegative(), title: z.string().max(256) });
export const ChangeSessionStatusV2Schema = z.strictObject({ sessionId: CatalogId, expectedRevision: z.number().int().nonnegative() });
export const StartTurnV2Schema = z.strictObject({ sessionId: CatalogId, expectedRevision: z.number().int().nonnegative().optional(), prompt: z.string().min(1).max(16 * 1024),clientMessageId:CatalogId.optional() });
export const InterruptTurnV2Schema = z.strictObject({ sessionId: CatalogId, expectedRevision: z.number().int().nonnegative().optional() });
export const RespondApprovalV2Schema = z.strictObject({ sessionId: CatalogId, approvalId: CatalogId, action: z.enum(["allow_once", "deny"]) });
export const ListSessionsV2Schema = z.strictObject({ workspaceId: CatalogId.optional(), includeArchived: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100), afterSessionId: CatalogId.optional() });
export const ListSessionsV2ResponseSchema = z.strictObject({sessions:z.array(SessionSummaryV2Schema).max(200),nextSessionId:CatalogId.optional()});
export type ListSessionsV2Response = z.infer<typeof ListSessionsV2ResponseSchema>;
export const SessionSnapshotV2Schema=z.strictObject({session:SessionSummaryV2Schema,activeTurn:z.object({id:CatalogId,sessionId:CatalogId,commandId:z.string(),status:z.enum(["queued","running","waiting_approval","interrupting","completed","failed","cancelled","outcome_unknown"]),prompt:z.string(),generation:z.number().int().nonnegative().optional(),startedAt:z.string().optional(),finishedAt:z.string().optional()}).optional(),pendingApprovals:z.array(z.unknown()),/** Timeline-delivered canonical snapshots carry a zeroed pendingInteractions marker: the authoritative pending interactions travel in the payload's `interactions` summary, not in the snapshot. The host always emits the key ([]) when an interaction directory exists; the RPC snapshot omits it. */pendingInteractions:z.array(z.unknown()).optional()});
export type SessionSnapshotV2=z.infer<typeof SessionSnapshotV2Schema>;
export const WorkspaceSummaryV2Schema = z.strictObject({workspaceId:CatalogId,label:z.string(),kind:z.enum(["local","worktree"]),state:z.enum(["active","needs_verification","disabled"]),repositoryId:CatalogId});
export const ProviderInstanceSummaryV2Schema = z.strictObject({providerInstanceId:CatalogId,provider:Provider,state:z.enum(["configured","unconfigured","disabled"]),verification:z.strictObject({state:z.enum(["unverified","verified","unsupported"]),runtimeVersion:z.string().optional()})});
export type WorkspaceSummaryV2 = z.infer<typeof WorkspaceSummaryV2Schema>;
export type ProviderInstanceSummaryV2 = z.infer<typeof ProviderInstanceSummaryV2Schema>;
export type CreateSessionV2 = z.infer<typeof CreateSessionV2Schema>;
export type RenameSessionV2 = z.infer<typeof RenameSessionV2Schema>;
export type ChangeSessionStatusV2 = z.infer<typeof ChangeSessionStatusV2Schema>;
export type StartTurnV2 = z.infer<typeof StartTurnV2Schema>;
export type SessionTargetV2=z.infer<typeof SessionTargetV2Schema>;
export type InterruptTurnV2=z.infer<typeof InterruptTurnV2Schema>;
export type RespondApprovalV2=z.infer<typeof RespondApprovalV2Schema>;
export type ListSessionsV2=z.infer<typeof ListSessionsV2Schema>;

export const SESSION_CATALOG_CAPABILITY = "session-registry-v1" as const;
export const SESSION_CATALOG_METHOD_SCOPES = Object.freeze({
  "workspace.list": "session:read", "provider.list": "session:read", "session.list": "session:read", "session.getSnapshot": "session:read",
  "session.createNew": "session:write", "session.rename": "session:write", "session.archive": "session:write", "session.unarchive": "session:write", "session.closeRuntime": "session:write",
} as const);

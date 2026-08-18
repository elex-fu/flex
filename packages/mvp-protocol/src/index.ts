import { z } from "zod";

export const ProtocolVersion = 1 as const;

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  details: z.unknown().optional(),
  traceId: z.string().optional(),
});

export type RpcError = z.infer<typeof RpcErrorSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.literal("default"),
  provider: z.literal("claude"),
  providerSessionId: z.string().optional(),
  status: z.enum(["active", "archived"]),
  activityState: z.enum([
    "idle",
    "running",
    "waiting_approval",
    "interrupting",
    "outcome_unknown",
    "runtime_unavailable",
  ]),
  headSequence: z.number().int().nonnegative(),
});

export type Session = z.infer<typeof SessionSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  commandId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "interrupting",
    "completed",
    "failed",
    "cancelled",
    "outcome_unknown",
  ]),
  prompt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export type Turn = z.infer<typeof TurnSchema>;

export const TimelineItemSchema = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  kind: z.enum(["user_message", "assistant_message", "tool_call", "approval", "error", "system"]),
  status: z.string(),
  revision: z.number().int().nonnegative(),
  content: z.unknown(),
  updatedAt: z.string(),
});

export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const SessionEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().positive(),
  type: z.string(),
  payload: z.unknown(),
  occurredAt: z.string(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const FrameSchema = z.union([
  z.object({
    type: z.literal("request"),
    id: z.string(),
    method: z.string(),
    commandId: z.string().optional(),
    payload: z.unknown().default({}),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string(),
    ok: z.literal(true),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string(),
    ok: z.literal(false),
    error: RpcErrorSchema,
  }),
  z.object({
    type: z.literal("event"),
    sessionId: z.string(),
    event: SessionEventSchema,
  }),
]);

export type Frame = z.infer<typeof FrameSchema>;

export const BootstrapSchema = z.object({
  protocolVersion: z.literal(ProtocolVersion),
  provider: z.literal("claude"),
  capabilities: z.object({
    streamingText: z.boolean(),
    structuredToolCalls: z.boolean(),
    interactiveApprovals: z.boolean(),
    resumeConversation: z.boolean(),
    interrupt: z.boolean(),
    gitDiff: z.boolean(),
    sandboxRequired: z.boolean(),
  }),
});

export type Bootstrap = z.infer<typeof BootstrapSchema>;

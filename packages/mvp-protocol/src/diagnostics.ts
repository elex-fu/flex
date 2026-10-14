import { z } from "zod";

const Count = z.number().int().nonnegative();
const Version = z.string().regex(/^(?:unknown|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/).max(128);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
export const UsageEvidenceSchema = z.object({
  source: z.enum(["native", "estimated", "unknown"]),
  availability: z.enum(["available", "unavailable"]),
  costUsd: z.number().finite().nonnegative().optional(),
}).strict().refine((value) => value.source !== "unknown" || (value.availability === "unavailable" && value.costUsd === undefined))
  .refine((value) => value.availability !== "unavailable" || value.costUsd === undefined)
  .refine((value) => value.availability !== "available" || value.costUsd !== undefined);
export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>;

export const VerifiedProviderEvidenceSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  verification: z.enum(["unverified", "deterministic", "native"]),
  sdkVersion: Version.optional(),
  cliVersion: Version.optional(),
  adapterVersion: Version.optional(),
  executableName: z.string().max(128).optional(),
  authMode: z.enum(["unknown", "signed_in", "api_key", "loopback_test"]).default("unknown"),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,95}$/)).max(64),
  verifiedAt: z.string().datetime().optional(),
  usage: UsageEvidenceSchema,
}).strict();
export type VerifiedProviderEvidence = z.infer<typeof VerifiedProviderEvidenceSchema>;

export const HostDiagnosticsSchema = z.object({
  v: z.literal(1),
  generatedAt: z.string().datetime(),
  owner: z.object({
    mode: z.enum(["runtime", "maintenance", "read_only", "unknown"]),
    state: z.enum(["active", "absent", "unverified", "closing"]),
    generation: Count.optional(),
  }).strict(),
  readiness: z.object({
    status: z.enum(["ready", "blocked", "maintenance", "read_only"]),
    reasonCodes: z.array(Code).max(32),
  }).strict(),
  schema: z.object({ migrationVersion: Count, userVersion: Count, supportedVersion: Count, writable: z.boolean() }).strict(),
  providers: z.array(VerifiedProviderEvidenceSchema).max(2).optional(),
  activity: z.object({ activeTurns: Count, unknownTurns: Count, activeIntents: Count, unknownIntents: Count }).strict().optional(),
  queues: z.object({ available: z.boolean(), queued: Count.optional(), capacity: Count.optional(), controlQueued: Count.optional(), controlCapacity: Count.optional() }).strict().optional(),
  timeline: z.object({ available: z.boolean(), sessions: Count, headSequence: Count, indexedSequence: Count.optional(), lag: Count.optional(), buildingEpochs: Count.optional() }).strict().optional(),
  content: z.object({ available: z.boolean(), refs: Count.optional(), bytes: Count.optional(), logicalRefBytes: Count.optional(), expiredRefs: Count.optional() }).strict().optional(),
  checkpoints: z.object({ available: z.boolean(), failed: Count.optional(), unsupported: Count.optional(), raced: Count.optional(), legacyInexact: Count.optional() }).strict().optional(),
  relay: z.object({ status: z.enum(["disabled", "connecting", "connected", "unavailable", "unknown"]), generation: Count.optional(), reasonCode: Code.optional() }).strict().optional(),
}).strict();
export type HostDiagnostics = z.infer<typeof HostDiagnosticsSchema>;

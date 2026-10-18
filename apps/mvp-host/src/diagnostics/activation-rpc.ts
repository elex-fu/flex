import { z } from "zod";
import type { HostActivationLoad } from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord, WorkspaceRecord } from "../storage/catalog-store.js";
import type { ActivationReasonCode } from "../storage/activation-store.js";
import { OperationsError } from "../operations/operation-files.js";

/**
 * Read-only `host.getExecutionReadiness` binding (design §13.1). It projects
 * the current activation verdicts for the requested resource pairs; it never
 * writes, never opens a Provider and never launches a process. Every execution
 * path must still re-check readiness — this DTO is a UI-facing snapshot, not a
 * permission.
 */

export const HOST_EXECUTION_READINESS_CAPABILITY = "host-execution-readiness-v1";
export const HOST_EXECUTION_READINESS_RPC_SCOPES = Object.freeze({ "host.getExecutionReadiness": "host:read" });
export const EXECUTION_READINESS_MAX_TARGETS = 50;

export type ExecutionReadinessBindings = Readonly<{
  load: HostActivationLoad;
  catalog: Readonly<{
    workspace(id: string): WorkspaceRecord | undefined;
    provider(id: string): ProviderInstanceRecord | undefined;
  }>;
  /** Main-owned owner facts; a retained/recovery-only owner reports `recovery_required`. */
  owner?: Readonly<{ recoveryOnly: boolean; retainedReason?: string | undefined }>;
  /** Read-only probe of the external-restore gate; a throw stays fail-closed. */
  restorePending?: () => boolean;
  /** Main-owned lifecycle fact while new admissions are being sealed. */
  draining?: () => boolean;
  now?: () => Date;
}>;

export type ExecutionReadinessTarget = Readonly<{
  workspaceId: string;
  providerInstanceId: string;
  resourceRevisions: Readonly<{ workspace: number; provider: number }>;
  capabilities: readonly string[];
  reasonCodes: readonly ActivationReasonCode[];
  evidenceId?: string;
  validUntil?: string;
}>;

export type ExecutionReadinessResponse = Readonly<{
  v: 1;
  generatedAt: string;
  hostState: "read_only" | "ready" | "draining" | "recovery_required";
  reasonCodes: readonly string[];
  targets: readonly ExecutionReadinessTarget[];
}>;

const IdentitySchema = z.string().min(1).max(256);
const ExecutionReadinessRequestSchema = z.strictObject({
  targets: z.array(z.strictObject({
    workspaceId: IdentitySchema,
    providerInstanceId: IdentitySchema,
  })).min(1).max(EXECUTION_READINESS_MAX_TARGETS),
});

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function recoveryRequired(bindings: ExecutionReadinessBindings): boolean {
  if (bindings.owner?.recoveryOnly || bindings.owner?.retainedReason) return true;
  try { return bindings.restorePending?.() === true; } catch { return true; }
}

const HOST_REASON_CODES = Object.freeze({
  recovery: "HOST_RECOVERY_REQUIRED",
  draining: "HOST_DRAINING",
  schema: "ACTIVATION_SCHEMA_UNAVAILABLE",
} as const);

/**
 * One read-only projection. Unknown targets, unreadable Stores and malformed
 * requests are typed refusals; a target that cannot be checked is reported with
 * its concrete reason codes instead of being treated as ready.
 */
export function hostExecutionReadinessRpc(
  bindings: ExecutionReadinessBindings,
  method: string,
  payload: unknown,
  scopes: ReadonlySet<string>,
): ExecutionReadinessResponse {
  if (!Object.hasOwn(HOST_EXECUTION_READINESS_RPC_SCOPES, method)) throw new OperationsError("METHOD_NOT_FOUND");
  if (!scopes.has("host:read")) throw new OperationsError("FORBIDDEN");
  const request = ExecutionReadinessRequestSchema.parse(payload);
  const recovery = recoveryRequired(bindings);
  const draining = !recovery && bindings.draining?.() === true;
  const targets: ExecutionReadinessTarget[] = [];
  let allValid = !recovery && !draining;
  for (const target of request.targets) {
    const workspace = bindings.catalog.workspace(target.workspaceId);
    const provider = bindings.catalog.provider(target.providerInstanceId);
    if (!workspace || !provider) {
      throw new OperationsError("ACTIVATION_RESOURCES_UNVERIFIED");
    }
    const workspaceReadiness = bindings.load.workspace(workspace);
    const providerReadiness = bindings.load.provider(provider);
    const ready = workspaceReadiness.ready && providerReadiness.ready;
    allValid = allValid && ready;
    const reasonCodes = sortedUnique([...workspaceReadiness.reasonCodes, ...providerReadiness.reasonCodes]);
    const sharedEvidence = ready && workspaceReadiness.evidenceId !== undefined && workspaceReadiness.evidenceId === providerReadiness.evidenceId;
    targets.push(Object.freeze({
      workspaceId: workspace.workspaceId,
      providerInstanceId: provider.providerInstanceId,
      resourceRevisions: Object.freeze({ workspace: workspaceReadiness.readinessRevision, provider: providerReadiness.readinessRevision }),
      // Capabilities are advertised only when both recorded verdicts are valid.
      capabilities: ready ? sortedUnique(workspace.capabilities.filter((capability) => provider.verification.capabilities.includes(capability))) : Object.freeze([]),
      reasonCodes,
      ...(sharedEvidence ? { evidenceId: workspaceReadiness.evidenceId!, ...(workspaceReadiness.validUntil ? { validUntil: workspaceReadiness.validUntil } : {}) } : {}),
    }));
  }
  const hostState: ExecutionReadinessResponse["hostState"] = recovery ? "recovery_required" : draining ? "draining" : allValid ? "ready" : "read_only";
  const reasonCodes = sortedUnique([
    ...(recovery ? [HOST_REASON_CODES.recovery] : []),
    ...(draining ? [HOST_REASON_CODES.draining] : []),
    ...(!bindings.load.available ? [HOST_REASON_CODES.schema] : []),
    ...targets.flatMap((target) => target.reasonCodes),
  ]);
  return Object.freeze({
    v: 1 as const,
    generatedAt: (bindings.now?.() ?? new Date()).toISOString(),
    hostState,
    reasonCodes,
    targets: Object.freeze(targets),
  });
}

import { realpathSync } from "node:fs";
import { MACOS_MANAGED_STOP_CONTRACT } from "../lifecycle/managed-stop-contract.js";
import type { ManagedGitRunRequest, ManagedGitRunResult, ManagedGitRunnerCloseReport } from "../lifecycle/managed-git-runner.js";
import { ManagedLaunchOrderLog, type ManagedLaunchOrderRecord, type ManagedLaunchOrderSnapshot } from "../lifecycle/managed-launch-order-log.js";
import { digest } from "./operation-files.js";
import { restoreExternalBindingDigest, type RestoreExternalBinding, type RestoreExternalObservation } from "./restore-external-check.js";

/** Read-only checkout inspection seam: the production reader is the managed git runner. */
export type RestoreCheckoutReader = {
  run(request: ManagedGitRunRequest): Promise<ManagedGitRunResult>;
  closeAndWait(deadlineMs?: number): Promise<ManagedGitRunnerCloseReport>;
};
/** Verified provider history seam: the production source is the native history manifest. */
export type RestoreHistoryManifestSource = (provider: string, providerInstanceId: string) => Readonly<{ evidenceId: string }> | undefined;

export type RestoreExternalInspectorOptions = {
  /** Database sibling ledger: survives the restore swap and owns the supervision window. */
  orderLog: ManagedLaunchOrderLog;
  /** Opens a scoped reader over the realpathed workspace roots for this inspection. */
  openCheckoutReader(roots: readonly string[]): RestoreCheckoutReader;
  /** Trusted recovery-read manifest for an exact provider instance. */
  manifestForInstance: RestoreHistoryManifestSource;
  /** Launches journaled under this runtime identity are the inspection's own and never producers. */
  inspectionRuntimeId?: string;
  realpath?: (path: string) => string;
  closeDeadlineMs?: number;
};

const HEAD_PATTERN = /^[0-9a-f]{40,64}$/;

function checkoutRequest(cwd: string, args: readonly string[], operationId: string, stepId: string): ManagedGitRunRequest {
  return { purpose: "session_diff", args, cwd, maxOutputBytes: 64 * 1024, timeoutMs: 10_000, operationId, stepId };
}

/**
 * Production `inspectExternal` (design §8.3): the order ledger bounds the
 * post-backup supervision window, scoped managed git reads re-verify each
 * checkout, and the trusted compatibility manifest re-verifies each restored
 * native history. Observation digests are stable across re-inspection: the
 * inspection's own git launches are journaled under a dedicated runtime
 * identity and filtered out of the supervisor view before digesting.
 */
export function createRestoreExternalInspector(options: RestoreExternalInspectorOptions) {
  const inspectionRuntimeId = options.inspectionRuntimeId ?? "restore-check-git";
  const realpath = options.realpath ?? realpathSync;
  return async function inspectExternal(binding: RestoreExternalBinding): Promise<RestoreExternalObservation> {
    const orderLog: ManagedLaunchOrderSnapshot = options.orderLog.read();
    const producers = orderLog.records.filter((record) => record.runtimeId !== inspectionRuntimeId);
    // Coverage holds only when the ledger observes the whole window from the
    // backup instant; any gap, malformed line, or absent ledger is unknown.
    const coverage = orderLog.exists && orderLog.malformed === 0 && orderLog.earliestAt !== undefined
      && orderLog.earliestAt <= binding.backupCreatedAt ? "complete" : "unknown";

    const checkouts = await inspectCheckouts(binding, options, realpath);
    const histories = binding.nativeHandles.map((handle) => {
      const provider = typeof handle.provider === "string" ? handle.provider : "";
      const providerInstanceId = typeof handle.provider_instance_id === "string" ? handle.provider_instance_id : "";
      const manifest = (provider === "claude" || provider === "codex") && providerInstanceId ? options.manifestForInstance(provider, providerInstanceId) : undefined;
      const evidenceId = manifest?.evidenceId ?? "";
      const verified = manifest !== undefined && /^[a-f0-9]{64}$/.test(evidenceId);
      return {
        handleId: String(handle.id),
        state: verified ? "verified" as const : "unknown" as const,
        sourceId: verified ? `compatibility-evidence@${evidenceId}` : "",
        historyDigest: evidenceId,
      };
    });

    return {
      version: 1,
      bindingDigest: restoreExternalBindingDigest(binding),
      supervisor: {
        sourceId: `managed-launch-order-log:${digest(JSON.stringify({ earliestAt: orderLog.earliestAt, malformed: orderLog.malformed, records: producers }))}`,
        since: binding.backupCreatedAt,
        coverage,
        launches: producerLaunches(producers),
        // Post-backup command receipts lived in the replaced database; devices
        // paired after the backup hold no restored credentials. Producer
        // effects are instead enumerated by launches, checkouts, and histories.
        unresolvedCommandIds: [],
      },
      checkouts,
      histories,
    };
  };
}

/** One checkout entry per workspace, "verified" only when a clean scoped read proved both refs views. */
async function inspectCheckouts(binding: RestoreExternalBinding, options: RestoreExternalInspectorOptions, realpath: (path: string) => string): Promise<RestoreExternalObservation["checkouts"][number][]> {
  const unknown = (workspaceId: string, checkoutRoot: string, checkoutKey: string) => ({ workspaceId, checkoutRoot, checkoutKey, state: "unknown" as const, sourceId: "", refsDigest: "" });
  const resolved = binding.workspaces.map((workspace) => {
    let root: string | undefined;
    try { root = realpath(workspace.checkoutRoot); } catch { root = undefined; }
    return { workspace, root };
  });
  if (!resolved.some((entry) => entry.root !== undefined)) return resolved.map((entry) => unknown(entry.workspace.id, entry.workspace.checkoutRoot, entry.workspace.checkoutKey));

  const reader = options.openCheckoutReader(resolved.filter((entry) => entry.root !== undefined).map((entry) => entry.root!));
  const queued = resolved.map((entry) => {
    if (!entry.root) return undefined;
    const operationId = `restore-check:${entry.workspace.id}`;
    // A failed read leaves the checkout unknown: it proves nothing, and never fabricates refs.
    const head = reader.run(checkoutRequest(entry.root, ["rev-parse", "HEAD"], operationId, "head")).catch(() => undefined);
    const status = reader.run(checkoutRequest(entry.root, ["status", "--porcelain"], operationId, "status")).catch(() => undefined);
    return { workspace: entry.workspace, head, status };
  });
  const runs = await Promise.all(queued.map(async (entry) => entry ? { workspace: entry.workspace, head: await entry.head, status: await entry.status } : undefined));
  const report = await reader.closeAndWait(options.closeDeadlineMs ?? 10_000);
  const clean = report.producerStopped && report.clean;
  return runs.map((run, index) => {
    const workspace = resolved[index]!.workspace;
    // Unclean closure leaves every read unproven, whatever the exit codes said.
    if (!run || !clean || !run.head || !run.status || run.head.exitCode !== 0 || run.status.exitCode !== 0) return unknown(workspace.id, workspace.checkoutRoot, workspace.checkoutKey);
    const head = Buffer.from(run.head.stdout).toString("utf8").trim();
    const status = Buffer.from(run.status.stdout).toString("utf8");
    if (!HEAD_PATTERN.test(head)) return unknown(workspace.id, workspace.checkoutRoot, workspace.checkoutKey);
    return {
      workspaceId: workspace.id, checkoutRoot: workspace.checkoutRoot, checkoutKey: workspace.checkoutKey,
      state: "verified" as const,
      sourceId: `managed-git/session-diff/v1@${run.head.launchDigest}`,
      refsDigest: digest(JSON.stringify({ head, status })),
    };
  });
}

/** Last write per launchId; only launches that ever held a pid had a producer. */
function producerLaunches(producers: readonly ManagedLaunchOrderRecord[]): RestoreExternalObservation["supervisor"]["launches"][number][] {
  const latest = new Map<string, ManagedLaunchOrderRecord>();
  const spawned = new Set<string>();
  for (const record of producers) {
    latest.set(record.launchId, record);
    if (record.pid !== undefined) spawned.add(record.launchId);
  }
  const launches: RestoreExternalObservation["supervisor"]["launches"][number][] = [];
  for (const [launchId, last] of latest) {
    if (!spawned.has(launchId)) continue;
    const stop = last.stop ? {
      kind: last.stop.contractId === MACOS_MANAGED_STOP_CONTRACT ? "managed-processes-stopped" as const : "process-tree-stopped" as const,
      sourceId: last.stop.sourceId, contractId: last.stop.contractId, launchDigest: last.stop.launchDigest,
    } : undefined;
    const state = last.state === "stopped" ? "stopped" as const : last.state === "running" ? "running" as const : "unknown" as const;
    launches.push({ launchId, launchDigest: last.launchDigest ?? "", state, ...(stop ? { stop } : {}) });
  }
  return launches;
}

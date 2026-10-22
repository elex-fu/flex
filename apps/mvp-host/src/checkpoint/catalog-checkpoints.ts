import { CHECKPOINT_DIFF_CAPABILITY } from "@flyx/mvp-protocol";
import type { RpcDomainPort } from "../api/rpc-dispatcher.js";
import type { HostCatalog } from "../catalog/host-catalog.js";
import type { ManagedGitRunner } from "../lifecycle/managed-git-runner.js";
import { SessionOrchestrator } from "../session/orchestrator.js";
import type { HostViews } from "../timeline/host-views.js";
import { CHECKPOINT_RPC_SCOPES, HostCheckpoints, type HostRevertPorts } from "./host-checkpoints.js";

/** One checkpoint service, bound to the actual lazy Session runtimes. */
export function createCatalogCheckpoints(catalog: HostCatalog, views: HostViews, runner: ManagedGitRunner | undefined, revert?: HostRevertPorts) {
  const runtime = (sessionId: string) => {
    const host = catalog.registry.loaded(sessionId);
    if (!(host instanceof SessionOrchestrator)) throw new Error("CHECKPOINT_RUNTIME_UNAVAILABLE");
    return host;
  };
  const checkpoints = new HostCheckpoints({
    store: catalog.store, owner: catalog.owner, registry: catalog.registry, workspaces: catalog.workspaces, views,
    authorizeSession: (sessionId, actorId, scope) => catalog.assertActorSession(actorId, sessionId, scope),
    runGit: runner?.checkpointGitRunner() ?? (async () => { throw new Error("MANAGED_GIT_BACKEND_UNAVAILABLE"); }),
    runtimeState: async (sessionId, actorId, purpose) => {
      const host = runtime(sessionId), lease = await host.ensureCheckpointLease({ actorId, purpose });
      if (purpose === "preview") host.beginCheckpointPreview(lease.operationId, actorId);
      const generation = (catalog.store.db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM turns WHERE session_id=?").get(sessionId) as { generation: number }).generation;
      return { lease, runtimeGeneration: generation, nativeHandle: catalog.registry.resolve(sessionId).session.nativeHandle };
    },
    leaseForContext: (context) => {
      const lease = runtime(context.sessionId).workspaceLease;
      if (!lease || lease.operationId !== context.lease.leaseId) throw new Error("WORKSPACE_LEASE_STALE");
      lease.assertActive(); return lease;
    },
    captureStateFor: (intent, dispatch, lease) => {
      const host = runtime(intent.sessionId!);
      if (host.runtimeId !== dispatch.runtimeId || host.workspaceLease !== lease) throw new Error("CHECKPOINT_RUNTIME_BINDING_INVALID");
      lease.assertActive();
      return { runtimeGeneration: dispatch.runtimeGeneration, nativeHandle: catalog.registry.resolve(intent.sessionId!).session.nativeHandle };
    },
    previewAborted: (sessionId, actorId) => { const host = runtime(sessionId); const lease = host.workspaceLease; if (lease && host.finishCheckpointPreview(lease.operationId, actorId)) host.releaseCheckpointLease(lease.operationId, actorId); },
    previewCreated: (sessionId, actorId, expiresAt) => { const host = runtime(sessionId); const lease = host.workspaceLease; if (lease && host.finishCheckpointPreview(lease.operationId, actorId)) host.bindCheckpointPreviewExpiry(lease.operationId, expiresAt, actorId); },
    ...(revert ? { revert } : {}),
    ...(runner ? { restoreOptions: { spawnHelper: runner.helperLauncher() } } : {}),
  });
  const port: RpcDomainPort = {
    methodScopes: CHECKPOINT_RPC_SCOPES, ready: () => catalog.store.db.open,
    capabilities: () => runner ? [CHECKPOINT_DIFF_CAPABILITY] : [],
    dispatch: (frame, context) => checkpoints.dispatchCheckpoint(frame, {
      ...context,
      assertAuthorized: (method) => context.assertAuthorized(method),
      assertSessionScope: (sessionId, scope) => { context.assertSessionScope?.(sessionId, scope); catalog.assertActorSession(context.subjectId, sessionId, scope); },
    }),
  };
  return { checkpoints, port };
}

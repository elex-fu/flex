import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { CheckpointGitDriver } from "../checkpoint/git-driver.js";
import type { ManagedGitRunner } from "../lifecycle/managed-git-runner.js";
import { validateTreeStopEvidence, type ProcessTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import type { DispatchContext } from "../provider/types.js";
import { worktreeDispatchContextDigest, worktreeWriterContextsDigest, type HostWorktreesOptions, type WorktreeProducerStopProof } from "./host-worktrees.js";
import { createScheduledHostWorktrees } from "./scheduled-host-worktrees.js";
import { WorktreeGitDriver } from "./worktree-git.js";
import type { RepositoryMetadataLocks } from "./repository-metadata-lock.js";
import type { OwnershipRecoveryAuthorization } from "../lifecycle/host-owner.js";

type StopRow = { id: string; state: string; identity_json: string | null; proof_json: string | null; boundary_json: string | null; launch_digest: string | null };
type ManagedOptions = Omit<HostWorktreesOptions, "git" | "producerStopProof" | "closeGit" | "sealGitJournal"> & {
  runner: ManagedGitRunner;
  /** Exact verified backend contract selected by application construction. */
  stopContractId: string;
  schedulerLimit?: number;
  repositoryMetadata?: { locks: RepositoryMetadataLocks };
};

/** Worktree helpers use the runner's actual prelaunch journal and original execution context. */
export function createManagedScheduledHostWorktrees(options: ManagedOptions) {
  if (!options.stopContractId) throw new Error("WORKTREE_STOP_CONTRACT_REQUIRED");
  let bindings: ReturnType<typeof createScheduledHostWorktrees> | undefined;
  const context = () => {
    const current = bindings?.worktrees.currentExecution();
    if (!current) throw new Error("WORKTREE_EXECUTION_CONTEXT_REQUIRED");
    return current;
  };
  const proofFor = (operationId: string, original: DispatchContext, successors: readonly DispatchContext[]): WorktreeProducerStopProof | undefined => {
    const contexts = [original, ...successors];
    const all: StopRow[] = [];
    try {
      for (const dispatch of contexts) {
        const rows = options.catalog.db.prepare(`SELECT p.id,p.state,i.identity_json,s.proof_json,b.proof_json AS boundary_json,b.launch_digest
          FROM managed_processes p LEFT JOIN managed_process_identities i ON i.process_id=p.id
          LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id LEFT JOIN managed_process_boundaries b ON b.process_id=p.id
          WHERE p.owner_id=? AND p.owner_generation=? AND p.runtime_id=? AND p.runtime_generation=? AND p.attempt_id=? AND p.session_id=? AND p.turn_id=? ORDER BY p.id`)
          .all(dispatch.hostOwnerId, dispatch.hostOwnerGeneration, dispatch.runtimeId, dispatch.runtimeGeneration, dispatch.attemptId, dispatch.sessionId, dispatch.flyxTurnId) as StopRow[];
        // Missing launch evidence never becomes an invented whole-tree proof.
        if (!rows.length) return undefined;
        for (const row of rows) {
          if (!row.boundary_json || !row.launch_digest || !/^[a-f0-9]{64}$/.test(row.launch_digest)) return undefined;
          const boundary = JSON.parse(row.boundary_json) as { kind?: string };
          if (boundary.kind !== "managed-git-launch-plan") return undefined;
          if (row.state === "not_spawned") continue;
          if (row.state !== "stopped" || !row.identity_json || !row.proof_json) return undefined;
          const proof = JSON.parse(row.proof_json) as ProcessTreeStopEvidence;
          validateTreeStopEvidence(proof, JSON.parse(row.identity_json) as ProcessIdentity);
          if (proof.contractId !== options.stopContractId) return undefined;
        }
        all.push(...rows);
      }
    } catch { return undefined; }
    const sourceId = createHash("sha256").update(JSON.stringify(all)).digest("hex");
    return { kind: "verified-worktree-stop", operationId, dispatchContextDigest: worktreeDispatchContextDigest(original),
      writerContextsDigest: worktreeWriterContextsDigest(contexts), sourceId, contractId: options.stopContractId };
  };
  const checkpoint = options.runner.checkpointGitRunner();
  const git = new WorktreeGitDriver({
    objects: (path) => new CheckpointGitDriver(path, { maxFileBytes: options.runner.policyFor("checkpoint_read").maxOutputBytes, runGit: (request) => {
      const execution = context();
      return checkpoint({ ...request, binding: { hostOwnerId: options.owner.ownerId, hostOwnerGeneration: options.owner.generation,
        workspaceId: bindings!.worktrees.store.require(execution.worktreeId).workspaceId } });
    } }),
    exec: async (request) => {
      const execution = context();
      const result = await options.runner.run({ purpose: "worktree_write", cwd: request.cwd, args: request.args, env: request.env,
        ...(request.input !== undefined ? { input: { encoding: "base64", data: request.input.toString("base64"), bytes: request.input.length } } : {}),
        operationId: execution.operationId, bindingDigest: worktreeDispatchContextDigest(execution.dispatchContext),
        maxOutputBytes: 32 * 1024 * 1024, timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) throw new Error("WORKTREE_GIT_FAILED");
      return Buffer.from(result.stdout);
    },
  });
  bindings = createScheduledHostWorktrees({ ...options, git,
    producerStopProof: async (operation, original, successors) => proofFor(operation.operationId, original, successors),
    recoveryAuthorization: options.recoveryAuthorization ?? ((record, operation, inspection, ownership) => bindings?.worktrees.ownershipRecoveryAuthorization(record, operation, inspection,
      (original, successors) => proofFor(operation.operationId, original, successors), ownership)),
    recoverRepositoryMetadata: options.recoverRepositoryMetadata ?? (async (record, operation, inspection) => {
      if (!options.repositoryMetadata) throw new Error("WORKTREE_METADATA_RECOVERY_REQUIRED");
      const execution = context();
      const result = await options.runner.run({ purpose: "checkpoint_read", cwd: record.repositoryRoot,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], operationId: operation.operationId,
        maxOutputBytes: 16 * 1024, timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error("REPOSITORY_COMMON_DIRECTORY_UNAVAILABLE");
      const commonDirectory = realpathSync(Buffer.from(result.stdout).toString("utf8").trim());
      const authorizations: Array<{ ownership: { ownerId: string; ownerGeneration: number; resourceKey: string; purpose: string }; authorization: OwnershipRecoveryAuthorization }> = [];
      const expectedOperation = JSON.stringify(bindings!.worktrees.store.operation(operation.operationId));
      options.repositoryMetadata.locks.recoverRetained({ commonDirectories: [commonDirectory], allowMissing: true,
        authorize: (ownership) => {
          if (!ownership.purpose.startsWith("repository:")) return undefined;
          const authorization = bindings!.worktrees.ownershipRecoveryAuthorization(record, operation, inspection,
            (original, successors) => proofFor(operation.operationId, original, successors), ownership,
            { resourceKey: `repository:${commonDirectory}`, purposeOperationId: ownership.purpose.slice("repository:".length) });
          if (authorization) authorizations.push({ ownership, authorization });
          return authorization;
        },
        commitAuthorization: () => options.catalog.db.transaction(() => {
          const current = bindings!.worktrees.store.operation(operation.operationId);
          if (JSON.stringify(current) !== expectedOperation || execution.dispatchContext.attemptId !== context().dispatchContext.attemptId
            || authorizations.some(({ ownership, authorization }) => !authorization.verifyProof(authorization.proof, { ...ownership, retainedReason: "recovery" }))) throw new Error("WORKTREE_RECOVERY_EVIDENCE_STALE");
          bindings!.worktrees.store.facts(operation.operationId, { metadataRecovery: { evidenceId: inspection.evidenceId,
            intentAttemptId: execution.dispatchContext.attemptId, resources: authorizations.map(({ ownership }) => ownership.resourceKey), observedRevision: record.revision } });
        })(),
      });
    }),
    closeGit: async (deadlineMs) => { const report = await options.runner.closeAndWait(deadlineMs); return { producerStopped: report.producerStopped, clean: report.clean }; },
    sealGitJournal: () => options.runner.sealJournal(),
  });
  return bindings;
}

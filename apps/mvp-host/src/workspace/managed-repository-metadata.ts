import { randomUUID } from "node:crypto";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { ManagedGitError, type ManagedGitPurpose, type ManagedGitRunner, type ManagedGitRunResult } from "../lifecycle/managed-git-runner.js";
import { RepositoryMetadataLocks } from "./repository-metadata-lock.js";

export type ManagedRepositoryMetadataInput = Readonly<{
  purpose: ManagedGitPurpose; cwd: string; args: readonly string[]; env: Readonly<Record<string, string>>; operationId?: string;
}>;
/** Bind once to the runner's short mutation dispatch port, including checkpoint update-ref. */
export function createManagedRepositoryMetadata(options: { owner: HostOwnerHandle; runner(): ManagedGitRunner }) {
  // The path passed to run is already a managed-query result, never an RPC path.
  const locks = new RepositoryMetadataLocks({ owner: options.owner, commonDirectory: async (path) => path, producerStopped: async () => false });
  const run = async <T>(input: ManagedRepositoryMetadataInput, action: () => Promise<T>): Promise<T> => {
    // Early fences precede the read helper as well as the mutating helper.
    assertHostOwner(options.owner);
    if (sealed) throw new Error("REPOSITORY_METADATA_LOCKS_SEALED");
    const common = await options.runner().run({ purpose: "checkpoint_read", cwd: input.cwd,
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], env: input.env,
      maxOutputBytes: 16 * 1024, timeoutMs: 5000,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
    if (common.exitCode !== 0) throw new Error("REPOSITORY_COMMON_DIRECTORY_UNAVAILABLE");
    const commonDirectory = Buffer.from(common.stdout).toString("utf8").trim();
    let producerStopped = false;
    return locks.run(commonDirectory, input.operationId ?? `metadata-${randomUUID()}`, async () => {
      try {
        const result = await action();
        const stopped = result as ManagedGitRunResult;
        producerStopped = stopped?.state === "stopped" && stopped.stopped === true && stopped.stopProof?.kind === "verified-tree-stop";
        return result;
      } catch (error) {
        producerStopped = error instanceof ManagedGitError && (error.state === "stopped" || error.state === "not_spawned");
        throw error;
      }
    }, async () => producerStopped);
  };
  let sealed = false;
  return { run, locks, seal: () => { sealed = true; locks.seal(); } };
}

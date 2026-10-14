import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../storage/db.js";
import { applyCheckpointSchema } from "../storage/migrations/009-checkpoints.js";
import { CheckpointGitDriver } from "./git-driver.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { CheckpointService } from "./checkpoint-service.js";
import type { CheckpointContext } from "./types.js";

export async function fixtureGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "buffer", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on("error", () => {}); child.stdin?.end(input);
  });
}
export async function temporaryRepository(unborn = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flyx-checkpoint-test-"));
  await fixtureGit(root, ["init", "-b", "main"]);
  await fixtureGit(root, ["config", "user.name", "Checkpoint Test"]);
  await fixtureGit(root, ["config", "user.email", "test@flyx.invalid"]);
  if (!unborn) {
    await writeFile(join(root, "tracked.txt"), "committed\n");
    await fixtureGit(root, ["add", "--", "tracked.txt"]);
    await fixtureGit(root, ["commit", "-m", "fixture"]);
  }
  return root;
}
export async function userGitState(root: string): Promise<{ index?: Buffer; head?: string; branch: string }> {
  const indexPath = (await fixtureGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString().trim();
  let index: Buffer | undefined; let head: string | undefined;
  try { index = await readFile(indexPath); } catch { /* Unborn index can be absent. */ }
  try { head = (await fixtureGit(root, ["rev-parse", "--verify", "HEAD"])).toString().trim(); } catch { /* Unborn HEAD. */ }
  const branch = (await fixtureGit(root, ["symbolic-ref", "HEAD"])).toString().trim();
  return { ...(index ? { index } : {}), ...(head ? { head } : {}), branch };
}
export function checkpointFixture(root: string, dbPath = ":memory:") {
  const owner = new SqliteStore(dbPath); const session = owner.createSession(root); applyCheckpointSchema(owner.db);
  const store = new CheckpointStore(owner.db); const driver = new CheckpointGitDriver(root);
  const context: CheckpointContext & { turnId: string; attemptId: string } = {
    sessionId: session.id, workspaceId: "default", turnId: "turn-1", attemptId: "attempt-1",
    lease: { workspaceId: "default", leaseId: "lease-1", generation: 1 }, sessionRevision: 2,
    epoch: "epoch-1", runtimeGeneration: 1, nativeHandle: { provider: "codex", sessionId: "native-1" },
  };
  const service = new CheckpointService({ store, driverFor: () => driver, assertLease: (value) => {
    if (value.lease.leaseId !== "lease-1") throw new Error("lost lease");
  } });
  return { owner, store, driver, context, service };
}
export async function removeFixture(root: string): Promise<void> { await rm(root, { force: true, recursive: true }); }

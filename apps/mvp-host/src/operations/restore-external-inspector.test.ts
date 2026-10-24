import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MANAGED_PROCESS_SCHEMA } from "../storage/migrations/004-managed-process-schema.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "../storage/migrations/005-process-evidence.js";
import { SqliteProcessJournal, type ManagedProcessRecord } from "../lifecycle/managed-process-registry.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "../lifecycle/managed-stop-contract.js";
import { MANAGED_LAUNCH_ORDER_FILENAME, ManagedLaunchOrderLog } from "../lifecycle/managed-launch-order-log.js";
import { createFixtureManagedGitRunner, fixtureLaunchContext } from "../test-support/managed-git-fixtures.js";
import { restoreExternalBindingDigest, type RestoreExternalBinding } from "./restore-external-check.js";
import { createRestoreExternalInspector, type RestoreCheckoutReader } from "./restore-external-inspector.js";
import type { ManagedGitRunRequest, ManagedGitRunResult } from "../lifecycle/managed-git-runner.js";

const exec = promisify(execFile);
const directories: string[] = [];
const databases: Database.Database[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const hex = (character: string) => character.repeat(64);
const backupCreatedAt = "2026-01-02T00:00:00.000Z";
const beforeBackup = () => new Date("2026-01-01T00:00:00.000Z");
const afterBackup = () => new Date("2026-01-03T00:00:00.000Z");

const context = { hostOwnerId: "owner", hostOwnerGeneration: 1, runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt", sessionId: "session", flyxTurnId: "turn" };
const proof = { version: 1 as const, boundaryId: "11111111-1111-4111-8111-111111111111", platform: "linux" as const, backend: "linux_bubblewrap" as const, kernelRelease: "fixture", backendVersion: "fixture", backendDigest: hex("a"), policyDigest: hex("b"), evidenceDigest: hex("c"), verifiedPrivateReadBoundary: true as const, verifiedPrivateWriteBoundary: true as const, verifiedChildInheritance: true as const, treeIsolation: "linux_pid_namespace" as const, verifiedDescendantStop: true };
const identity = { pid: 4242, platform: "linux" as const, birth: { kind: "linux" as const, bootId: "22222222-2222-4222-8222-222222222222", startTicks: "100" } };
const producer: ManagedProcessRecord = { ...context, id: "launch-1", state: "stopped", pid: identity.pid, processGroup: identity.pid,
  processIdentity: identity, treeControl: "process_group", boundaryEvidence: { proof, launchDigest: hex("l") },
  stopProof: { kind: "verified-tree-stop" as const, sourceId: "kernel-observation", identityDigest: processIdentityDigest(identity), contractId: "native-boundary/v1/linux_bubblewrap/" + hex("c") } };

async function fixture(): Promise<{ directory: string; log: ManagedLaunchOrderLog }> {
  const directory = await mkdtemp(join(tmpdir(), "flyx-inspector-")); directories.push(directory);
  return { directory, log: new ManagedLaunchOrderLog(join(directory, MANAGED_LAUNCH_ORDER_FILENAME)) };
}
function bindingFixture(overrides: Partial<RestoreExternalBinding> = {}): RestoreExternalBinding {
  return { version: 1, gateDigest: hex("g"), backupManifestDigest: hex("m"), databaseDigest: hex("d"), backupCreatedAt,
    workspaces: [{ id: "ws-1", checkoutRoot: "/repo", checkoutKey: "key-1" }],
    nativeHandles: [{ id: "handle-1", provider: "claude", provider_instance_id: "pi-1" }], ...overrides };
}

/** Deterministic scoped reader: two runs per workspace (head, status) under a fixed launch digest. */
function fakeReader(input: { head?: string; status?: string; exitCode?: number; clean?: boolean; reject?: boolean } = {}) {
  const requests: ManagedGitRunRequest[] = [];
  let closed = 0;
  const reader: RestoreCheckoutReader = {
    run: async (request) => {
      requests.push(request);
      if (input.reject) throw new Error("READER_UNAVAILABLE");
      const head = request.args.includes("rev-parse");
      const result: ManagedGitRunResult = { purpose: "session_diff", policyId: "managed-git/session-diff/v1", launchDigest: hex("g"), processId: "p-1",
        stdout: Buffer.from(head ? (input.head ?? `${"a".repeat(40)}\n`) : (input.status ?? ""), "utf8"),
        exitCode: input.exitCode ?? 0, state: "stopped", stopped: true,
        stopProof: { kind: "verified-tree-stop", sourceId: "fake-stop", identityDigest: hex("i"), contractId: "fixture-verified-tree-stop/v1" } };
      return result;
    },
    closeAndWait: async () => { closed += 1; return { closed: true as const, producerStopped: true, clean: input.clean ?? true, runs: requests.length }; },
  };
  return { reader, requests, closedCount: () => closed };
}

describe("restore external inspector", () => {
  it("produces the full production observation for a covered, stopped, verified host", async () => {
    const f = await fixture();
    f.log.ensureOpen(beforeBackup);
    f.log.record(producer);
    const manifests = vi.fn(() => ({ evidenceId: hex("e") }));
    const checkout = fakeReader();
    const inspect = createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: () => checkout.reader, manifestForInstance: manifests, realpath: (path) => path });
    const binding = bindingFixture();
    const observation = await inspect(binding);
    expect(observation.version).toBe(1);
    expect(observation.bindingDigest).toBe(restoreExternalBindingDigest(binding));
    expect(observation.supervisor.sourceId).toMatch(/^managed-launch-order-log:[a-f0-9]{64}$/);
    expect(observation.supervisor).toMatchObject({ since: backupCreatedAt, coverage: "complete", unresolvedCommandIds: [] });
    expect(observation.supervisor.launches).toEqual([{ launchId: "launch-1", launchDigest: hex("l"), state: "stopped",
      stop: { kind: "process-tree-stopped", sourceId: "kernel-observation", contractId: "native-boundary/v1/linux_bubblewrap/" + hex("c"), launchDigest: hex("l") } }]);
    expect(observation.checkouts).toEqual([{ workspaceId: "ws-1", checkoutRoot: "/repo", checkoutKey: "key-1", state: "verified",
      sourceId: `managed-git/session-diff/v1@${hex("g")}`, refsDigest: createHash("sha256").update(JSON.stringify({ head: "a".repeat(40), status: "" })).digest("hex") }]);
    expect(observation.histories).toEqual([{ handleId: "handle-1", state: "verified", sourceId: `compatibility-evidence@${hex("e")}`, historyDigest: hex("e") }]);
    // Two scoped session-diff reads per workspace, closed before the observation is returned.
    expect(checkout.requests.map((request) => [request.purpose, request.args[0], request.cwd])).toEqual([
      ["session_diff", "rev-parse", "/repo"], ["session_diff", "status", "/repo"]]);
    expect(checkout.closedCount()).toBe(1);
    expect(manifests).toHaveBeenCalledExactlyOnceWith("claude", "pi-1");
  });

  it("digests the same supervisor view across re-inspection while the ledger grows with its own launches", async () => {
    const f = await fixture();
    f.log.ensureOpen(beforeBackup);
    f.log.record(producer);
    const checkout = fakeReader();
    const inspect = createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: () => checkout.reader, manifestForInstance: () => ({ evidenceId: hex("e") }), realpath: (path) => path });
    const first = await inspect(bindingFixture());
    // The inspection's own git launches really happened and are journaled too —
    // under the dedicated inspection runtime identity.
    f.log.record({ ...producer, id: "inspection-1", runtimeId: "restore-check-git", boundaryEvidence: { proof, launchDigest: hex("x") } });
    const second = await inspect(bindingFixture());
    expect(second.supervisor.sourceId).toBe(first.supervisor.sourceId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(f.log.read().records.filter((record) => record.runtimeId === "restore-check-git")).toHaveLength(1);
  });

  it("leaves coverage unknown when the ledger is absent, late, or malformed", async () => {
    const absent = await fixture();
    const inspectAbsent = createRestoreExternalInspector({ orderLog: absent.log, openCheckoutReader: () => fakeReader().reader, manifestForInstance: () => undefined, realpath: (path) => path });
    expect((await inspectAbsent(bindingFixture())).supervisor.coverage).toBe("unknown");
    const late = await fixture();
    late.log.ensureOpen(afterBackup);
    const inspectLate = createRestoreExternalInspector({ orderLog: late.log, openCheckoutReader: () => fakeReader().reader, manifestForInstance: () => undefined, realpath: (path) => path });
    expect((await inspectLate(bindingFixture())).supervisor.coverage).toBe("unknown");
    const malformed = await fixture();
    malformed.log.ensureOpen(beforeBackup);
    await writeFile(malformed.log.path, "garbage\n", { flag: "a" });
    const inspectMalformed = createRestoreExternalInspector({ orderLog: malformed.log, openCheckoutReader: () => fakeReader().reader, manifestForInstance: () => undefined, realpath: (path) => path });
    expect((await inspectMalformed(bindingFixture())).supervisor.coverage).toBe("unknown");
  });

  it("enumerates only launches that ever held a pid, and maps their stop contracts", async () => {
    const f = await fixture();
    f.log.ensureOpen(beforeBackup);
    f.log.record(producer);
    f.log.record({ ...context, id: "launch-2", state: "not_spawned", treeControl: "process_group" });
    f.log.record({ ...context, id: "launch-3", runtimeId: "runtime", state: "running", pid: 5150, processGroup: 5150, processIdentity: { ...identity, pid: 5150 }, treeControl: "process_group" });
    f.log.record({ ...context, id: "launch-4", state: "launching", pid: 6160, processGroup: 6160, processIdentity: { ...identity, pid: 6160 }, treeControl: "process_group" });
    f.log.record({ ...producer, id: "launch-5", processGroup: identity.pid,
      stopProof: { kind: "managed-group-stop" as const, sourceId: "supervisor", identityDigest: processIdentityDigest(identity),
        contractId: MACOS_MANAGED_STOP_CONTRACT, launchDigest: hex("l"), processGroup: identity.pid, rootExitObserved: true, groupAbsent: true, observedAt: "2026-01-01T00:00:01.000Z" } });
    const inspect = createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: () => fakeReader().reader, manifestForInstance: () => undefined, realpath: (path) => path });
    const launches = (await inspect(bindingFixture())).supervisor.launches;
    // launch-2 never had a producer; launch-5's supervisor stop maps to the managed contract.
    expect(launches.map((launch) => [launch.launchId, launch.state])).toEqual([["launch-1", "stopped"], ["launch-3", "running"], ["launch-4", "unknown"], ["launch-5", "stopped"]]);
    expect(launches.at(-1)!.stop).toMatchObject({ kind: "managed-processes-stopped", contractId: MACOS_MANAGED_STOP_CONTRACT, launchDigest: hex("l") });
  });

  it("leaves a checkout unknown for unclean closure, failed reads, or a malformed head", async () => {
    const cases = [fakeReader({ clean: false }), fakeReader({ exitCode: 1 }), fakeReader({ head: "not-a-sha\n" }), fakeReader({ reject: true })];
    for (const checkout of cases) {
      const f = await fixture();
      const inspect = createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: () => checkout.reader, manifestForInstance: () => ({ evidenceId: hex("e") }), realpath: (path) => path });
      expect((await inspect(bindingFixture())).checkouts).toEqual([
        { workspaceId: "ws-1", checkoutRoot: "/repo", checkoutKey: "key-1", state: "unknown", sourceId: "", refsDigest: "" }]);
    }
  });

  it("never opens a reader when no workspace root resolves", async () => {
    const f = await fixture();
    const opened = vi.fn(() => fakeReader().reader);
    const inspect = createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: opened, manifestForInstance: () => undefined,
      realpath: () => { throw new Error("ENOENT"); } });
    expect((await inspect(bindingFixture())).checkouts[0]).toMatchObject({ state: "unknown" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("leaves histories unknown without a trusted manifest, an exact provider, or a digest-shaped evidence id", async () => {
    const f = await fixture();
    const inspect = (manifest: ReturnType<typeof vi.fn>) => createRestoreExternalInspector({ orderLog: f.log, openCheckoutReader: () => fakeReader().reader, manifestForInstance: manifest, realpath: (path) => path });
    const absent = vi.fn(() => undefined);
    expect((await inspect(absent)(bindingFixture())).histories[0]).toMatchObject({ handleId: "handle-1", state: "unknown", sourceId: "", historyDigest: "" });
    const otherProvider = vi.fn(() => ({ evidenceId: hex("e") }));
    expect((await inspect(otherProvider)(bindingFixture({ nativeHandles: [{ id: "handle-1", provider: "other", provider_instance_id: "pi-1" }] }))).histories[0]).toMatchObject({ state: "unknown" });
    expect(otherProvider).not.toHaveBeenCalled();
    const malformed = vi.fn(() => ({ evidenceId: "not-hex" }));
    expect((await inspect(malformed)(bindingFixture())).histories[0]).toMatchObject({ state: "unknown", sourceId: "", historyDigest: "not-hex" });
  });
});

describe("restore external inspector over a real managed git runner", { timeout: 60_000 }, () => {
  it("verifies a real checkout through the managed git boundary and stays stable across re-inspection", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "flyx-inspector-git-"))); directories.push(root);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
    await writeFile(join(root, "README.md"), "fixture\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture"], { cwd: root });
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

    const f = await fixture();
    f.log.ensureOpen(beforeBackup);
    f.log.record(producer);
    // Inspection launches journal into a scratch database: the restored facts never move.
    const scratch = new Database(":memory:"); databases.push(scratch);
    scratch.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA);
    const journal = new SqliteProcessJournal(scratch, f.log);
    const inspectionRuntimeId = "restore-check-git";
    const inspect = createRestoreExternalInspector({
      orderLog: f.log, inspectionRuntimeId,
      openCheckoutReader: (roots) => createFixtureManagedGitRunner({ journal, roots: () => [...roots],
        context: () => fixtureLaunchContext({ runtimeId: inspectionRuntimeId }) }),
      manifestForInstance: () => ({ evidenceId: hex("e") }),
    });
    const binding = bindingFixture({ workspaces: [{ id: "ws-1", checkoutRoot: root, checkoutKey: "key-1" }] });
    const first = await inspect(binding);
    expect(first.supervisor.coverage).toBe("complete");
    expect(first.supervisor.launches.map((launch) => launch.launchId)).toEqual(["launch-1"]);
    expect(first.checkouts[0]).toMatchObject({ workspaceId: "ws-1", checkoutRoot: root, checkoutKey: "key-1", state: "verified" });
    expect(first.checkouts[0]!.refsDigest).toBe(createHash("sha256").update(JSON.stringify({ head: head.trim(), status: "" })).digest("hex"));
    expect(first.checkouts[0]!.sourceId).toMatch(/^managed-git\/session-diff\/v1@[a-f0-9]{64}$/);
    // The real runner journaled its own inspection launches into the ledger.
    expect(f.log.read().records.filter((record) => record.runtimeId === inspectionRuntimeId).length).toBeGreaterThanOrEqual(2);
    const second = await inspect(binding);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

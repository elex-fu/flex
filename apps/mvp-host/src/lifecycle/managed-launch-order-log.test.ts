import { afterEach, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { MANAGED_PROCESS_SCHEMA } from "../storage/migrations/004-managed-process-schema.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "../storage/migrations/005-process-evidence.js";
import { SqliteProcessJournal, type ManagedProcessRecord } from "./managed-process-registry.js";
import { processIdentityDigest } from "./managed-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";
import { MANAGED_LAUNCH_ORDER_FILENAME, ManagedLaunchOrderLog, managedLaunchOrderLogFor } from "./managed-launch-order-log.js";

const directories: string[] = [];
const databases: Database.Database[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const hex = (character: string) => character.repeat(64);
const context = { hostOwnerId: "owner", hostOwnerGeneration: 1, runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt", sessionId: "session", flyxTurnId: "turn" };
const proof = { version: 1 as const, boundaryId: "11111111-1111-4111-8111-111111111111", platform: "linux" as const, backend: "linux_bubblewrap" as const, kernelRelease: "fixture", backendVersion: "fixture", backendDigest: hex("a"), policyDigest: hex("b"), evidenceDigest: hex("c"), verifiedPrivateReadBoundary: true as const, verifiedPrivateWriteBoundary: true as const, verifiedChildInheritance: true as const, treeIsolation: "linux_pid_namespace" as const, verifiedDescendantStop: true };
const identity = { pid: 4242, platform: "linux" as const, birth: { kind: "linux" as const, bootId: "22222222-2222-4222-8222-222222222222", startTicks: "100" } };
const stoppedRecord: ManagedProcessRecord = { ...context, id: "launch-1", state: "stopped", pid: identity.pid, processGroup: identity.pid,
  processIdentity: identity, treeControl: "process_group", boundaryEvidence: { proof, launchDigest: hex("f") },
  stopProof: { kind: "verified-tree-stop" as const, sourceId: "kernel-observation", identityDigest: processIdentityDigest(identity), contractId: "native-boundary/v1/linux_bubblewrap/" + hex("c") } };

async function fixture(): Promise<{ directory: string; log: ManagedLaunchOrderLog }> {
  const directory = await mkdtemp(join(tmpdir(), "flyx-order-log-")); directories.push(directory);
  return { directory, log: new ManagedLaunchOrderLog(join(directory, MANAGED_LAUNCH_ORDER_FILENAME)) };
}

describe("managed launch order ledger location", () => {
  it("keeps one ledger per database path and none for an in-memory database", () => {
    expect(managedLaunchOrderLogFor(":memory:")).toBeUndefined();
    expect(managedLaunchOrderLogFor("")).toBeUndefined();
    expect(managedLaunchOrderLogFor("/private/flyx/mvp.sqlite")?.path).toBe(join(dirname("/private/flyx/mvp.sqlite"), MANAGED_LAUNCH_ORDER_FILENAME));
  });
});

describe("managed launch order ledger", () => {
  it("anchors the supervision window with a single header the first time the Host opens it", async () => {
    const f = await fixture();
    f.log.ensureOpen(() => new Date("2026-01-01T00:00:00.000Z"));
    f.log.ensureOpen(() => new Date("2026-01-05T00:00:00.000Z"));
    const snapshot = f.log.read();
    expect(snapshot).toMatchObject({ exists: true, malformed: 0, earliestAt: "2026-01-01T00:00:00.000Z", records: [] });
    expect((await readFile(f.log.path, "utf8")).trim()).toBe(JSON.stringify({ v: 1, kind: "log-opened", at: "2026-01-01T00:00:00.000Z" }));
    expect(statSync(f.log.path).mode & 0o777).toBe(0o600);
  });
  it("reads an absent ledger as coverage-absent, never as an error", () => {
    const log = new ManagedLaunchOrderLog(join("/nonexistent-flyx-order", MANAGED_LAUNCH_ORDER_FILENAME));
    expect(log.read()).toMatchObject({ exists: false, digest: "", malformed: 0, earliestAt: undefined, records: [] });
  });
  it("records journaled transitions after their durable database commit", async () => {
    const f = await fixture();
    f.log.ensureOpen(() => new Date("2026-01-01T00:00:00.000Z"));
    const db = new Database(":memory:"); databases.push(db);
    db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA);
    const journal = new SqliteProcessJournal(db, f.log);
    journal.save({ ...context, id: "launch-1", state: "launching", treeControl: "process_group", boundaryEvidence: { proof, launchDigest: hex("f") } });
    journal.save(stoppedRecord);
    const snapshot = f.log.read();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.records.map((record) => record.state)).toEqual(["launching", "stopped"]);
    // The verified-tree-stop proof carries no launch digest of its own: the stop
    // borrows the launch digest of the boundary it stopped.
    const stopped = snapshot.records.at(-1)!;
    expect(stopped).toMatchObject({ launchId: "launch-1", pid: identity.pid, state: "stopped", launchDigest: hex("f"),
      stop: { kind: "verified-tree-stop", sourceId: "kernel-observation", contractId: "native-boundary/v1/linux_bubblewrap/" + hex("c"), launchDigest: hex("f") } });
    expect(snapshot.digest).toBe(createHash("sha256").update(await readFile(f.log.path)).digest("hex"));
  });
  it("never records a transition whose database transaction failed", async () => {
    const f = await fixture();
    f.log.ensureOpen(() => new Date("2026-01-01T00:00:00.000Z"));
    const db = new Database(":memory:"); databases.push(db);
    db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA);
    const journal = new SqliteProcessJournal(db, f.log);
    // A stopped record without a stop proof fails the journal contract before any ledger write.
    expect(() => journal.save({ ...context, id: "launch-1", state: "stopped", pid: identity.pid, treeControl: "process_group" })).toThrow("PROCESS_STOP_PROOF_REQUIRED");
    expect(f.log.read().records).toHaveLength(0);
  });
  it("prefers a stop proof's own launch digest when it carries one", async () => {
    const f = await fixture();
    f.log.record({ ...stoppedRecord, stopProof: { kind: "managed-group-stop" as const, sourceId: "supervisor", identityDigest: processIdentityDigest(identity),
      contractId: MACOS_MANAGED_STOP_CONTRACT, launchDigest: hex("9"), processGroup: identity.pid, rootExitObserved: true, groupAbsent: true, observedAt: "2026-01-01T00:00:01.000Z" } });
    const record = f.log.read().records[0]!;
    expect(record.stop).toMatchObject({ kind: "managed-group-stop", contractId: MACOS_MANAGED_STOP_CONTRACT, launchDigest: hex("9") });
  });
  it("counts malformed lines while still reading the valid ones", async () => {
    const f = await fixture();
    f.log.ensureOpen(() => new Date("2026-01-01T00:00:00.000Z"));
    f.log.record(stoppedRecord);
    await writeFile(f.log.path, "not json\n\n{\"v\":1,\"unexpected\":true}\n", { flag: "a" });
    const snapshot = f.log.read();
    expect(snapshot.malformed).toBe(3);
    expect(snapshot.records).toHaveLength(1);
    // The header still anchors the earliest observation; the appended junk is late anyway.
    expect(snapshot.earliestAt).toBe("2026-01-01T00:00:00.000Z");
    await chmod(f.log.path, 0o644);
    expect(f.log.read().digest).toBe(createHash("sha256").update(await readFile(f.log.path)).digest("hex"));
  });
});

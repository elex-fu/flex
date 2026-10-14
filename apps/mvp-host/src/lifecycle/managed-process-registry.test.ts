import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MANAGED_PROCESS_SCHEMA, MANAGED_PROCESS_IDENTITY_SCHEMA, SqliteProcessJournal, ManagedProcessRegistry, processIdentityDigest, type ManagedProcessRecord } from "./managed-process-registry.js";

const context = { hostOwnerId: "owner", hostOwnerGeneration: 1, runtimeId: "runtime", runtimeGeneration: 2, attemptId: "attempt" };
function fixture(group: "present" | "absent" | "unknown" = "absent") {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 5_000_000, stdin: new PassThrough(), kill: () => true });
  const records: ManagedProcessRecord[] = [];
  let spawned = false;
  const registry = new ManagedProcessRegistry({
    journal: { save: (record) => records.push({ ...record }) }, context: () => context,
    spawn: (() => { expect(records.at(-1)?.state).toBe("launching"); spawned = true; return child; }) as typeof spawn,
    groupExists: () => group,
    identify: (pid) => ({ pid, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "10" } }),
    verifyDescendantStop: (record) => ({ kind: "verified-tree-stop", sourceId: "controlled-tree-stop", contractId: "fixture-descendant-contract", identityDigest: processIdentityDigest(record.processIdentity!) }),
  });
  return { registry, child, records, spawned: () => spawned };
}

describe("managed process ownership", () => {
  it("journals before spawn and only accepts descendant exit proof", async () => {
    const { registry, child, records } = fixture();
    registry.spawn("fixture", [], { stdio: "pipe" });
    expect(records.map((record) => record.state)).toEqual(["launching", "running"]);
    child.emit("exit", 0, null);
    const first = registry.closeAndWait(0);
    expect(registry.closeAndWait(0)).toBe(first);
    expect((await first).stopped).toBe(true);
    expect(records.at(-1)?.state).toBe("stopped");
    expect(() => registry.spawn("fixture", [], {})).toThrow("RUNTIME_CLOSING");
  });
  it.each(["present", "unknown"] as const)("root exit does not release a %s process group", async (group) => {
    const { registry, child, records } = fixture(group);
    registry.spawn("fixture", [], {}); child.emit("exit", 0, null);
    expect((await registry.closeAndWait(0)).treeStopped).toBe(false);
    expect(records.at(-1)?.errorCode).toBe("PROCESS_TREE_STOP_UNPROVEN");
  });
  it("rejects an unwritable launching journal without starting a process", () => {
    let spawnCount = 0;
    const registry = new ManagedProcessRegistry({ journal: { save() { throw new Error("disk"); } },
      context: () => context, spawn: (() => { spawnCount++; }) as unknown as typeof spawn });
    expect(() => registry.spawn("fixture", [], {})).toThrow("disk"); expect(spawnCount).toBe(0);
  });
  it("spawn failure is recorded without treating a launching crash as exit proof", async () => {
    const records: ManagedProcessRecord[] = [];
    const registry = new ManagedProcessRegistry({ journal: { save: (record) => records.push({ ...record }) },
      context: () => context, spawn: (() => { throw new Error("ENOENT"); }) as typeof spawn });
    expect(() => registry.spawn("fixture", [], {})).toThrow("ENOENT");
    expect(records.map((record) => record.state)).toEqual(["launching", "not_spawned"]);
    expect((await registry.closeAndWait(0)).stopped).toBe(true);
  });
  it("unverified process group exit remains blocked even when the group vanished", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 5_000_000, stdin: new PassThrough(), kill: () => true });
    const registry = new ManagedProcessRegistry({ journal: { save() {} }, context: () => context,
      spawn: (() => child) as typeof spawn, groupExists: () => "absent" });
    registry.spawn("fixture", [], {}); child.emit("exit", 0, null);
    expect((await registry.closeAndWait(0)).treeStopped).toBe(false);
  });
  it("persists immutable process birth atomically with PID and rejects reuse", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_IDENTITY_SCHEMA);
      const journal = new SqliteProcessJournal(db);
      const record: ManagedProcessRecord = { ...context, id: "process", state: "launching", treeControl: "process_group" };
      journal.save(record);
      const identity = { pid: 42, platform: "linux" as const, birth: { kind: "linux" as const, bootId: "boot", startTicks: "10" } };
      journal.save({ ...record, state: "running", pid: 42, processIdentity: identity });
      expect(() => journal.save({ ...record, state: "root_exited", pid: 43, processIdentity: { ...identity, pid: 43 } })).toThrow("PROCESS_BIRTH_CONFLICT");
      expect(db.prepare("SELECT pid,state FROM managed_processes").get()).toEqual({ pid: 42, state: "running" });
    } finally { db.close(); }
  });
  it("fences late exit journal callbacks before Store closure", () => {
    const { registry, child, records } = fixture();
    registry.spawn("fixture", [], {}); const count = records.length;
    registry.sealJournal(); child.emit("exit", 0, null);
    expect(records).toHaveLength(count);
  });
  it("persists exact launch boundary before spawn and rolls back attempts to replace it", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_IDENTITY_SCHEMA);
      const journal = new SqliteProcessJournal(db);
      const record: ManagedProcessRecord = { ...context, id: "bound-process", state: "launching", treeControl: "process_group",
        boundaryEvidence: { proof: { policyDigest: "private-denial", verifiedDescendantStop: false }, launchDigest: "a".repeat(64) } };
      journal.save(record);
      expect(db.prepare("SELECT proof_json,launch_digest FROM managed_process_boundaries").get()).toEqual({ proof_json: JSON.stringify(record.boundaryEvidence!.proof), launch_digest: "a".repeat(64) });
      expect(() => journal.save({ ...record, state: "unknown", boundaryEvidence: { ...record.boundaryEvidence!, launchDigest: "b".repeat(64) } })).toThrow("PROCESS_BOUNDARY_CONFLICT");
      expect(db.prepare("SELECT state FROM managed_processes").get()).toEqual({ state: "launching" });
    } finally { db.close(); }
  });
  it("requires a birth-bound immutable stop proof before persisting stopped", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_IDENTITY_SCHEMA);
      const journal = new SqliteProcessJournal(db);
      const identity = { pid: 42, platform: "linux" as const, birth: { kind: "linux" as const, bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "10" } };
      const record: ManagedProcessRecord = { ...context, id: "stopped-process", state: "running", pid: 42, treeControl: "process_group", processIdentity: identity };
      journal.save(record);
      expect(() => journal.save({ ...record, state: "stopped" })).toThrow("PROCESS_STOP_PROOF_REQUIRED");
      const stopProof = { kind: "verified-tree-stop" as const, sourceId: "tree-exit", contractId: "verified-contract", identityDigest: processIdentityDigest(identity) };
      journal.save({ ...record, state: "stopped", stopProof });
      expect(() => journal.save({ ...record, state: "stopped", stopProof: { ...stopProof, sourceId: "other-exit" } })).toThrow("PROCESS_STOP_PROOF_CONFLICT");
      expect(db.prepare("SELECT proof_json FROM managed_process_stop_proofs").get()).toEqual({ proof_json: JSON.stringify(stopProof) });
    } finally { db.close(); }
  });
});

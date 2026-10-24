import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ManagedProcessRecord, ManagedProcessState } from "./managed-process-registry.js";

/**
 * Host-private managed launch/stop order ledger (design §8.3). The ledger is a
 * database sibling: a restore replaces only the database file, so this ledger
 * survives the swap and independently enumerates every producer that ran after
 * the backup was taken. The journal commits each transition to the database
 * first; only a durable commit reaches this ledger.
 */
export const MANAGED_LAUNCH_ORDER_FILENAME = "managed-launch-order.jsonl";

export type ManagedLaunchOrderRecord = Readonly<{
  v: 1;
  at: string;
  launchId: string;
  ownerId: string;
  ownerGeneration: number;
  runtimeId: string;
  runtimeGeneration: number;
  attemptId: string;
  sessionId?: string;
  turnId?: string;
  state: ManagedProcessState;
  pid?: number;
  launchDigest?: string;
  stop?: Readonly<{ kind: string; sourceId: string; contractId: string; launchDigest: string }>;
}>;

export type ManagedLaunchOrderSnapshot = Readonly<{
  exists: boolean;
  /** sha256 over the whole ledger file; empty when the ledger is absent. */
  digest: string;
  /** Unparsable or unshapely lines: any malformed line leaves coverage unknown. */
  malformed: number;
  /** Earliest timestamp any line observes, header included. */
  earliestAt: string | undefined;
  records: readonly ManagedLaunchOrderRecord[];
}>;

const STATES: readonly ManagedProcessState[] = ["launching", "running", "root_exited", "stopped", "not_spawned", "unknown"];

function isOrderRecord(value: unknown): value is ManagedLaunchOrderRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && typeof record.at === "string" && record.at.length > 0
    && typeof record.launchId === "string" && record.launchId.length > 0
    && typeof record.ownerId === "string" && typeof record.ownerGeneration === "number"
    && typeof record.runtimeId === "string" && typeof record.runtimeGeneration === "number"
    && typeof record.attemptId === "string"
    && (record.sessionId === undefined || typeof record.sessionId === "string")
    && (record.turnId === undefined || typeof record.turnId === "string")
    && typeof record.state === "string" && STATES.includes(record.state as ManagedProcessState)
    && (record.pid === undefined || typeof record.pid === "number")
    && (record.launchDigest === undefined || typeof record.launchDigest === "string")
    && (record.stop === undefined || (typeof record.stop === "object" && record.stop !== null
      && ["kind", "sourceId", "contractId", "launchDigest"].every((key) => typeof (record.stop as Record<string, unknown>)[key] === "string")));
}

function isHeader(value: unknown): value is { v: 1; kind: "log-opened"; at: string } {
  return typeof value === "object" && value !== null
    && (value as Record<string, unknown>).v === 1
    && (value as Record<string, unknown>).kind === "log-opened"
    && typeof (value as Record<string, unknown>).at === "string";
}

const earlier = (current: string | undefined, candidate: string): string => (current === undefined || candidate < current ? candidate : current);

export class ManagedLaunchOrderLog {
  constructor(readonly path: string) {}

  /**
   * Anchors coverage at Host start: the header line is the ledger's earliest
   * observation even when no producer ever launched, so a backup taken later
   * can prove the supervision window is complete.
   */
  ensureOpen(now: () => Date = () => new Date()): void {
    try {
      const fd = openSync(this.path, "wx", 0o600);
      try { writeSync(fd, `${JSON.stringify({ v: 1, kind: "log-opened", at: now().toISOString() })}\n`); }
      finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /** Records one journaled launch/stop transition. A write failure fails the caller closed. */
  record(record: ManagedProcessRecord): void {
    const proof = record.stopProof as { kind: string; sourceId: string; contractId: string; launchDigest?: string } | undefined;
    const line: ManagedLaunchOrderRecord = {
      v: 1,
      at: new Date().toISOString(),
      launchId: record.id,
      ownerId: record.hostOwnerId,
      ownerGeneration: record.hostOwnerGeneration,
      runtimeId: record.runtimeId,
      runtimeGeneration: record.runtimeGeneration,
      attemptId: record.attemptId,
      state: record.state,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.flyxTurnId !== undefined ? { turnId: record.flyxTurnId } : {}),
      ...(record.boundaryEvidence ? { launchDigest: record.boundaryEvidence.launchDigest } : {}),
      ...(proof ? { stop: { kind: proof.kind, sourceId: proof.sourceId, contractId: proof.contractId,
        // The stop belongs to the launch it stopped: the boundary launch digest
        // backs stops whose proof variant carries no digest of its own.
        launchDigest: proof.launchDigest ?? record.boundaryEvidence?.launchDigest ?? "" } } : {}),
    };
    const fd = openSync(this.path, "a", 0o600);
    try { writeSync(fd, `${JSON.stringify(line)}\n`); }
    finally { closeSync(fd); }
  }

  read(): ManagedLaunchOrderSnapshot {
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, digest: "", malformed: 0, earliestAt: undefined, records: [] };
      throw error;
    }
    let malformed = 0;
    let earliestAt: string | undefined;
    const records: ManagedLaunchOrderRecord[] = [];
    const text = bytes.toString("utf8");
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    for (const line of lines) {
      if (line === "") { malformed += 1; continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { malformed += 1; continue; }
      if (isOrderRecord(parsed)) { records.push(Object.freeze(parsed)); earliestAt = earlier(earliestAt, parsed.at); }
      else if (isHeader(parsed)) { earliestAt = earlier(earliestAt, parsed.at); }
      else malformed += 1;
    }
    return { exists: true, digest: createHash("sha256").update(bytes).digest("hex"), malformed, earliestAt, records };
  }
}

/** One ledger per database path; an in-memory database keeps no host-private ledger. */
export function managedLaunchOrderLogFor(databasePath: string): ManagedLaunchOrderLog | undefined {
  if (!databasePath || databasePath === ":memory:") return undefined;
  return new ManagedLaunchOrderLog(join(dirname(databasePath), MANAGED_LAUNCH_ORDER_FILENAME));
}

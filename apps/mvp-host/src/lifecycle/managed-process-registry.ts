import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SystemProcessInspector, type ProcessIdentity } from "./process-inspector.js";
import { processIdentityDigest, validateTreeStopEvidence, type ProcessBoundaryEvidence, type ProcessTreeStopEvidence } from "./managed-process-evidence.js";
import { adoptNodeChildProcess, type ManagedChildHandle } from "./managed-child-handle.js";
import { savePlannedCompatibilityLaunch } from "../diagnostics/managed-native-provenance.js";
import type { PlannedNativeArtifact } from "../diagnostics/planned-native-artifact.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "../storage/migrations/005-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";
export { MANAGED_PROCESS_SCHEMA } from "../storage/migrations/004-managed-process-schema.js";
export { processIdentityDigest, type ProcessBoundaryEvidence, type ProcessTreeStopEvidence } from "./managed-process-evidence.js";
export type { ManagedChildExit, ManagedChildHandle, ManagedChildRawEvidence } from "./managed-child-handle.js";

export type ProcessLaunchContext = {
  hostOwnerId: string;
  hostOwnerGeneration: number;
  runtimeId: string;
  runtimeGeneration: number;
  attemptId: string;
  sessionId?: string;
  flyxTurnId?: string;
};
export type ManagedProcessState = "launching" | "running" | "root_exited" | "stopped" | "not_spawned" | "unknown";
export type ManagedProcessRecord = ProcessLaunchContext & {
  id: string;
  state: ManagedProcessState;
  pid?: number;
  processGroup?: number;
  treeControl: "process_group" | "unavailable";
  errorCode?: string;
  processIdentity?: ProcessIdentity;
  boundaryEvidence?: ProcessBoundaryEvidence;
  stopProof?: ProcessTreeStopEvidence;
};
/** stopped follows each launch's explicit contract; treeStopped only claims complete descendant isolation. */
export type ProcessStopResult = { stopped: boolean; treeStopped: boolean; records: ManagedProcessRecord[] };
export interface ProcessJournal { save(record: ManagedProcessRecord): void; savePlannedLaunch?(record: ManagedProcessRecord, planned: PlannedNativeArtifact): void; }

/** Compatibility export; production installs the complete 005 evidence metadata. */
export const MANAGED_PROCESS_IDENTITY_SCHEMA = MANAGED_PROCESS_EVIDENCE_SCHEMA;

export class SqliteProcessJournal implements ProcessJournal {
  /** The host-private launch/stop order ledger survives database restores. */
  constructor(private readonly db: Database.Database,
    private readonly orderLog?: { record(record: ManagedProcessRecord): void }) {}
  savePlannedLaunch(record: ManagedProcessRecord, planned: PlannedNativeArtifact): void {
    if (!record.boundaryEvidence) throw new Error("COMPATIBILITY_PLANNED_LAUNCH_INVALID");
    savePlannedCompatibilityLaunch(this.db, record.id, record.boundaryEvidence.launchDigest, planned);
  }
  save(record: ManagedProcessRecord): void {
    this.db.transaction(() => {
    if (record.state === "stopped" && !record.stopProof) throw new Error("PROCESS_STOP_PROOF_REQUIRED");
    const previous = this.db.prepare("SELECT owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control FROM managed_processes WHERE id = ?").get(record.id) as Record<string, unknown> | undefined;
    const immutable = { owner_id: record.hostOwnerId, owner_generation: record.hostOwnerGeneration, runtime_id: record.runtimeId,
      runtime_generation: record.runtimeGeneration, attempt_id: record.attemptId, session_id: record.sessionId ?? null,
      turn_id: record.flyxTurnId ?? null, tree_control: record.treeControl };
    if (previous && (Object.entries(immutable).some(([key, value]) => previous[key] !== value) ||
        (previous.pid !== null && previous.pid !== record.pid) ||
        (previous.process_group !== null && previous.process_group !== record.processGroup))) throw new Error("PROCESS_BIRTH_CONFLICT");
    this.db.prepare(`INSERT INTO managed_processes
      (id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,error_code,updated_at)
      VALUES (@id,@ownerId,@ownerGeneration,@runtimeId,@runtimeGeneration,@attemptId,@sessionId,@turnId,@pid,@processGroup,@treeControl,@state,@errorCode,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,process_group=excluded.process_group,
      state=excluded.state,error_code=excluded.error_code,updated_at=excluded.updated_at`).run({
      id: record.id, ownerId: record.hostOwnerId, ownerGeneration: record.hostOwnerGeneration,
      runtimeId: record.runtimeId, runtimeGeneration: record.runtimeGeneration, attemptId: record.attemptId,
      sessionId: record.sessionId ?? null, turnId: record.flyxTurnId ?? null, pid: record.pid ?? null,
      processGroup: record.processGroup ?? null, treeControl: record.treeControl, state: record.state,
      errorCode: record.errorCode ?? null, updatedAt: new Date().toISOString(),
    });
    if (record.processIdentity) {
      const identity = JSON.stringify(record.processIdentity);
      this.db.prepare("INSERT OR IGNORE INTO managed_process_identities(process_id,identity_json) VALUES(?,?)").run(record.id, identity);
      const saved = this.db.prepare("SELECT identity_json FROM managed_process_identities WHERE process_id = ?").get(record.id) as { identity_json: string };
      if (saved.identity_json !== identity) throw new Error("PROCESS_BIRTH_CONFLICT");
    }
    if (record.boundaryEvidence) {
      const { proof, launchDigest } = record.boundaryEvidence;
      if (!/^[a-f0-9]{64}$/.test(launchDigest)) throw new Error("PROCESS_BOUNDARY_INVALID");
      const encoded = JSON.stringify(proof);
      this.db.prepare("INSERT OR IGNORE INTO managed_process_boundaries(process_id,proof_json,launch_digest) VALUES(?,?,?)").run(record.id, encoded, launchDigest);
      const saved = this.db.prepare("SELECT proof_json,launch_digest FROM managed_process_boundaries WHERE process_id = ?").get(record.id) as { proof_json: string; launch_digest: string };
      if (saved.proof_json !== encoded || saved.launch_digest !== launchDigest) throw new Error("PROCESS_BOUNDARY_CONFLICT");
    }
    if (record.stopProof) {
      validateTreeStopEvidence(record.stopProof, record.processIdentity, record.boundaryEvidence, record.processGroup);
      const encoded = JSON.stringify(record.stopProof);
      this.db.prepare("INSERT OR IGNORE INTO managed_process_stop_proofs(process_id,proof_json) VALUES(?,?)").run(record.id, encoded);
      const saved = this.db.prepare("SELECT proof_json FROM managed_process_stop_proofs WHERE process_id = ?").get(record.id) as { proof_json: string };
      if (saved.proof_json !== encoded) throw new Error("PROCESS_STOP_PROOF_CONFLICT");
    }
    })();
    // Only a durable database commit reaches the ledger: a failed transaction
    // never overstates the supervision window.
    this.orderLog?.record(record);
  }
}

type Entry = { handle: ManagedChildHandle; record: ManagedProcessRecord; exited: boolean };
export class ManagedProcessRegistry {
  private readonly entries = new Map<string, Entry>();
  private closing = false;
  private closePromise: Promise<ProcessStopResult> | undefined;
  private journalSealed = false;
  constructor(private readonly options: {
    journal: ProcessJournal;
    context: () => ProcessLaunchContext;
    spawn?: typeof spawn;
    groupExists?: (pid: number) => "present" | "absent" | "unknown";
    gracefulExitMs?: number;
    stopMode?: "managed_process_group";
    signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
    identify?: (pid: number) => ProcessIdentity;
    /** Trusted local verifier bound to this process's persisted boundary and birth identity. */
    verifyDescendantStop?: (record: ManagedProcessRecord) => ProcessTreeStopEvidence | undefined | Promise<ProcessTreeStopEvidence | undefined>;
  }) {}

  spawn(command: string, args: readonly string[], options: SpawnOptions, boundaryEvidence?: ProcessBoundaryEvidence & { plannedArtifact?: PlannedNativeArtifact }): ManagedChildHandle {
    if (this.closing) throw new Error("RUNTIME_CLOSING");
    const grouped = process.platform !== "win32";
    const record: ManagedProcessRecord = {
      ...this.options.context(), id: randomUUID(), state: "launching",
      treeControl: grouped ? "process_group" : "unavailable",
      ...(boundaryEvidence ? { boundaryEvidence } : {}),
    };
    // Commit launching before crossing the external spawn boundary.
    this.options.journal.save(record);
    if (boundaryEvidence?.plannedArtifact) this.options.journal.savePlannedLaunch?.(record, boundaryEvidence.plannedArtifact);
    let child: ChildProcess;
    try { child = (this.options.spawn ?? spawn)(command, [...args], { ...options, detached: grouped }); }
    catch (error) {
      record.state = "not_spawned"; record.errorCode = "SPAWN_THROW";
      this.options.journal.save(record);
      throw error;
    }
    const handle = adoptNodeChildProcess({ id: record.id, child, grouped });
    handle.stdin?.on("error", () => { /* A closed input is not an exit observation. */ });
    const entry: Entry = { handle, record, exited: false };
    this.entries.set(record.id, entry);
    void handle.exited.then(() => {
      if (entry.exited) return;
      entry.exited = true;
      // A handle without a PID never observed an OS process: its terminal
      // observation settles as "never spawned", never as a normal root exit.
      if (handle.pid === undefined) { record.state = "not_spawned"; record.errorCode = "SPAWN_FAILED"; }
      else if (record.state !== "stopped") record.state = "root_exited";
      this.persist(record);
    });
    handle.on("error", () => {
      if (handle.pid === undefined) {
        entry.exited = true; record.state = "not_spawned"; record.errorCode = "SPAWN_FAILED";
      } else { record.state = "unknown"; record.errorCode = "PROCESS_ERROR"; }
      this.persist(record);
    });
    if (handle.pid !== undefined) {
      record.pid = handle.pid;
      record.processIdentity = (this.options.identify ?? ((pid) => new SystemProcessInspector({ pid, observeMacosBirth: this.options.stopMode === "managed_process_group" }).currentIdentity()))(handle.pid);
      if (grouped) record.processGroup = handle.pid;
      record.state = "running";
      // If this commit fails after spawn, the durable launching row remains a recovery gate.
      try { this.options.journal.save(record); }
      catch (error) { record.state = "unknown"; record.errorCode = "PID_PERSIST_FAILED"; void this.stopEntry(entry, 1_000); throw error; }
    }
    return handle;
  }

  records(): ManagedProcessRecord[] { return [...this.entries.values()].map(({ record }) => ({ ...record })); }
  /** Called after durable unknown settlement and before closing the shared Store. */
  sealJournal(): void {
    this.journalSealed = true;
    // Detach only this Host's IPC handles after drain/unknown settlement. An
    // escaped descendant holding a pipe is still durably unknown, never stopped.
    for (const entry of this.entries.values()) entry.handle.dispose();
  }
  closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> {
    this.closing = true;
    this.closePromise ??= this.closeInternal(deadlineMs);
    return this.closePromise;
  }
  private async closeInternal(deadlineMs: number): Promise<ProcessStopResult> {
    const entries = [...this.entries.values()];
    const results = await Promise.all(entries.map((entry) => this.stopEntry(entry, deadlineMs)));
    const stopped = results.every(Boolean);
    const records = this.records();
    return { stopped, treeStopped: stopped && records.every((record) => record.state === "not_spawned" || record.stopProof?.kind === "verified-tree-stop"), records };
  }
  private async stopEntry(entry: Entry, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, deadlineMs);
    try { entry.handle.stdin?.end(); } catch { /* group proof still required */ }
    let exit = await entry.handle.waitForExit(Math.min(this.options.gracefulExitMs ?? 2_000, Math.max(0, deadlineMs / 2)));
    if (exit) entry.exited = true;
    if (!exit) {
      this.signalOwnedRoot(entry, "SIGTERM");
      exit = await entry.handle.waitForExit(Math.max(0, (deadline - Date.now()) / 2));
      if (exit) entry.exited = true;
    }
    if (!exit) {
      this.signalOwnedRoot(entry, "SIGKILL");
      exit = await entry.handle.waitForExit(Math.max(0, deadline - Date.now()));
      if (exit) entry.exited = true;
    }
    if (entry.record.state === "not_spawned") return true;
    const group = entry.record.processGroup;
    let proof = group === undefined ? "unknown" : (this.options.groupExists ?? groupExists)(group);
    if (this.options.stopMode === "managed_process_group" && group !== undefined && proof === "present") {
      // A root may exit while its tools still hold the group and stdio. Clean
      // that original group too; ChildProcess.kill deliberately refuses an exited root.
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        try { (this.options.signalGroup ?? ((pid, value) => process.kill(-pid, value)))(group, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") break; }
        const until = signal === "SIGTERM" ? Date.now() + Math.max(0, (deadline - Date.now()) / 2) : deadline;
        do {
          proof = (this.options.groupExists ?? groupExists)(group);
          if (proof !== "present" || Date.now() >= until) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(0, until - Date.now()))));
        } while (true);
        if (proof !== "present") break;
      }
    }
    if (this.options.stopMode !== "managed_process_group" && entry.exited && proof === "absent" && this.options.verifyDescendantStop) {
      try {
        const stopProof = await this.options.verifyDescendantStop({ ...entry.record });
        if (stopProof) {
          validateTreeStopEvidence(stopProof, entry.record.processIdentity, entry.record.boundaryEvidence, group);
          entry.record.stopProof = stopProof;
          entry.record.state = "stopped";
          return this.persist(entry.record);
        }
      } catch { /* Unavailable or invalid proof retains the recovery gate. */ }
    }
    if (this.options.stopMode === "managed_process_group" && entry.exited && proof === "absent" && group !== undefined && entry.record.processIdentity && entry.record.boundaryEvidence) {
      const stopProof: ProcessTreeStopEvidence = { kind: "managed-group-stop", version: 1, contractId: MACOS_MANAGED_STOP_CONTRACT,
        sourceId: `${entry.record.id}:managed-group-stop/v1`, identityDigest: processIdentityDigest(entry.record.processIdentity),
        launchDigest: entry.record.boundaryEvidence.launchDigest, processGroup: group, rootExitObserved: true, groupAbsent: true, observedAt: new Date().toISOString() };
      try {
        validateTreeStopEvidence(stopProof, entry.record.processIdentity, entry.record.boundaryEvidence, group);
        entry.record.stopProof = stopProof; entry.record.state = "stopped";
        return this.persist(entry.record);
      } catch { /* Original contract/binding missing: preserve unknown. */ }
    }
    // Never infer descendant exit from root exit or the boolean returned by kill().
    entry.record.state = "unknown"; entry.record.errorCode = "PROCESS_TREE_STOP_UNPROVEN";
    this.persist(entry.record);
    return false;
  }
  private signalOwnedRoot(entry: Entry, signal: NodeJS.Signals): void {
    // The handle refuses to signal an already observed exit or a missing PID,
    // so a signal request never becomes exit proof or a recycled-PID kill.
    entry.handle.kill(signal);
  }
  private persist(record: ManagedProcessRecord): boolean {
    if (this.journalSealed) return false;
    try { this.options.journal.save(record); return true; }
    catch { record.state = "unknown"; record.errorCode = "PROCESS_JOURNAL_UNWRITABLE"; return false; }
  }
}

function groupExists(pid: number): "present" | "absent" | "unknown" {
  try { process.kill(-pid, 0); return "present"; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
  }
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { digest, identityMirror, OperationsError, validateDatabase, type SnapshotCoordinator } from "./operation-files.js";
import { readRestoreReadinessGate, validateBackup } from "./restore-service.js";

export type RestoreExternalBinding = Readonly<{
  version: 1; gateDigest: string; backupManifestDigest: string; databaseDigest: string;
  backupCreatedAt: string;
  workspaces: readonly Readonly<{ id: string; checkoutRoot: string; checkoutKey: string }>[];
  /** Includes all saved handles, including unresolved attempts. Missing receipts prove nothing. */
  nativeHandles: readonly Readonly<Record<string, unknown>>[];
}>;
export type RestoreExternalObservation = Readonly<{
  version: 1; bindingDigest: string;
  supervisor: Readonly<{
    sourceId: string; since: string; coverage: "complete" | "unknown";
    launches: readonly Readonly<{ launchId: string; launchDigest: string; state: "stopped" | "running" | "unknown";
      stop?: Readonly<{ kind: "process-tree-stopped"; sourceId: string; contractId: string; launchDigest: string }> }>[];
    /** Unknown post-backup commands must remain blocked even if no restored receipt exists. */
    unresolvedCommandIds: readonly string[];
  }>;
  checkouts: readonly Readonly<{ workspaceId: string; checkoutRoot: string; checkoutKey: string;
    state: "verified" | "unknown"; sourceId: string; refsDigest: string }>[];
  histories: readonly Readonly<{ handleId: string; state: "verified" | "unknown"; sourceId: string; historyDigest: string }>[];
}>;
export type RestoreCheckReceipt = Readonly<{
  operationId: string; evidenceId: string; revision: number; state: "ready" | "rejected" | "completed";
  validUntil: string; reasonCodes: readonly string[];
}>;
export type RestoreExternalCheckOptions = {
  db: Database.Database; owner: HostOwnerHandle; backupDirectory: string; identityDirectory: string;
  supportedSchemaVersion: number; withSnapshot: SnapshotCoordinator;
  /** Original persistent supervisor ledger and current read-only checkout/history inspection. */
  inspectExternal(binding: RestoreExternalBinding): Promise<RestoreExternalObservation>;
  now?: () => Date; evidenceTtlMs?: number;
};
type Evidence = { version: 1; id: string; digest: string; binding: RestoreExternalBinding; observation: RestoreExternalObservation; validUntil: string; reasonCodes: string[] };
type Row = { id: string; state: string; revision: number; request_hash: string; owner_context_json: string; evidence_json: string | null; result_json: string | null };
const hash = /^[a-f0-9]{64}$/;
const jsonDigest = (value: unknown) => digest(JSON.stringify(value));

/** Local maintenance workflow; the only resource write is deleting this exact restore gate. */
export class RestoreExternalCheckService {
  constructor(private readonly options: RestoreExternalCheckOptions) {}
  private guard(): void {
    assertHostOwner(this.options.owner); this.options.owner.assertStorePath(this.options.db.name);
    if (this.options.owner.mode !== "maintenance") throw new OperationsError("RESTORE_OFFLINE_OWNER_REQUIRED");
  }
  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
  private ownerContext(): string {
    return JSON.stringify({ ownerId: this.options.owner.ownerId, ownerGeneration: this.options.owner.generation, resourceKeys: [...this.options.owner.resourceKeys] });
  }
  private rows(table: string): Record<string, unknown>[] {
    return this.options.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  }
  private async binding(): Promise<RestoreExternalBinding> {
    this.guard();
    const gate = readRestoreReadinessGate(this.options.db);
    if (!gate) throw new OperationsError("RESTORE_GATE_MISSING");
    if (!gate.backupManifestDigest) throw new OperationsError("RESTORE_BACKUP_BINDING_MISSING");
    const manifest = await validateBackup(this.options.backupDirectory, this.options.supportedSchemaVersion);
    const manifestDigest = jsonDigest(manifest);
    if (manifestDigest !== gate.backupManifestDigest || manifest.createdAt !== gate.backupCreatedAt) throw new OperationsError("RESTORE_BACKUP_BINDING_CHANGED");
    const mirror = identityMirror(this.options.db);
    if (mirror.hostId !== manifest.identity.hostId || mirror.fingerprint !== manifest.identity.fingerprint) throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
    await loadOrCreateHostIdentity({ directory: this.options.identityDirectory, expectedMirror: mirror });
    validateDatabase(this.options.db, this.options.supportedSchemaVersion);
    // Exclude this workflow's journal so inspection itself does not invalidate evidence.
    const tables = ["workspaces", "provider_instances", "sessions", "session_catalog", "turns", "execution_intents", "command_receipts", "native_turn_bindings", "managed_processes", "managed_process_identities", "managed_process_boundaries", "recovery_operations", "worktree_operations", "checkpoint_reverts"];
    const facts: Record<string, unknown> = {};
    for (const table of tables) {
      if (!this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = this.options.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const order = columns.map((column) => column.name).filter((name) => /^[a-z_]+$/.test(name)).map((name) => `"${name}"`).join(",");
      facts[table] = this.options.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    }
    const workspaces = this.rows("workspaces").map((row) => ({ id: String(row.id), checkoutRoot: String(row.worktree_root), checkoutKey: String(row.checkout_key) }));
    const nativeHandles = (facts.native_turn_bindings ?? []) as Record<string, unknown>[];
    this.guard();
    return { version: 1, gateDigest: jsonDigest(gate), backupManifestDigest: manifestDigest, databaseDigest: jsonDigest(facts), backupCreatedAt: gate.backupCreatedAt, workspaces, nativeHandles };
  }
  private reasons(binding: RestoreExternalBinding, observation: RestoreExternalObservation): string[] {
    const reasons: string[] = [];
    if (observation.version !== 1 || observation.bindingDigest !== jsonDigest(binding)) reasons.push("RESTORE_EXTERNAL_BINDING_CHANGED");
    const supervisor = observation.supervisor;
    if (!supervisor?.sourceId || supervisor.coverage !== "complete" || supervisor.since !== binding.backupCreatedAt) reasons.push("RESTORE_SUPERVISOR_COVERAGE_UNVERIFIED");
    if (!supervisor || supervisor.unresolvedCommandIds.length || supervisor.launches.some((launch) => launch.state !== "stopped" || !launch.launchId || !hash.test(launch.launchDigest)
      || launch.stop?.kind !== "process-tree-stopped" || !launch.stop.sourceId || !launch.stop.contractId || launch.stop.launchDigest !== launch.launchDigest)) reasons.push("RESTORE_ORIGINAL_OPERATIONS_UNRESOLVED");
    for (const workspace of binding.workspaces) {
      const matches = observation.checkouts.filter((check) => check.workspaceId === workspace.id);
      const check = matches[0];
      if (matches.length !== 1 || check?.checkoutRoot !== workspace.checkoutRoot || check.checkoutKey !== workspace.checkoutKey
        || check.state !== "verified" || !check.sourceId || !hash.test(check.refsDigest)) reasons.push("RESTORE_GIT_STATE_UNVERIFIED");
    }
    for (const handle of binding.nativeHandles) {
      const matches = observation.histories.filter((check) => check.handleId === handle.id);
      if (matches.length !== 1 || matches[0]?.state !== "verified" || !matches[0].sourceId || !hash.test(matches[0].historyDigest)) reasons.push("RESTORE_PROVIDER_HISTORY_UNVERIFIED");
    }
    return [...new Set(reasons)].sort();
  }
  async inspectState(input: { commandId: string }): Promise<RestoreCheckReceipt> {
    return this.options.withSnapshot(async () => {
      this.guard();
      if (!input.commandId || input.commandId.length > 256) throw new OperationsError("RESTORE_CHECK_INVALID_COMMAND");
      const actorId = `local-restore:${this.options.owner.ownerId}`;
      const requestHash = jsonDigest({ version: 1, backupDirectory: this.options.backupDirectory });
      const existing = this.options.db.prepare("SELECT * FROM host_execution_operations WHERE actor_id=? AND command_id=?").get(actorId, input.commandId) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash || existing.owner_context_json !== this.ownerContext()) throw new OperationsError("RESTORE_CHECK_COMMAND_CONFLICT");
        return this.receipt(existing);
      }
      const operationId = randomUUID(); const at = this.now().toISOString();
      this.options.db.prepare(`INSERT INTO host_execution_operations(id,actor_id,command_id,kind,request_hash,state,revision,owner_context_json,resource_binding_json,created_at,updated_at)
        VALUES(?,?,?,'restore_check',?,'checking',0,?,'{}',?,?)`).run(operationId, actorId, input.commandId, requestHash, this.ownerContext(), at, at);
      try {
        const binding = await this.binding();
        const observation = await this.options.inspectExternal(binding);
        const reasons = this.reasons(binding, observation);
        if (jsonDigest(binding) !== jsonDigest(await this.binding())) throw new OperationsError("RESTORE_CHECK_STALE");
        const evidence: Evidence = { version: 1, id: randomUUID(), digest: jsonDigest({ binding, observation }), binding, observation,
          validUntil: new Date(this.now().getTime() + Math.min(300_000, Math.max(1, this.options.evidenceTtlMs ?? 60_000))).toISOString(), reasonCodes: reasons };
        this.guard();
        const result = this.options.db.prepare("UPDATE host_execution_operations SET state=?,revision=revision+1,evidence_json=?,updated_at=? WHERE id=? AND kind='restore_check' AND state='checking' AND revision=0")
          .run(reasons.length ? "rejected" : "ready", JSON.stringify(evidence), this.now().toISOString(), operationId);
        if (result.changes !== 1) throw new OperationsError("RESTORE_CHECK_STALE");
        return this.receipt(this.row(operationId));
      } catch (error) {
        this.guard();
        this.options.db.prepare("UPDATE host_execution_operations SET state='outcome_unknown',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND state='checking'")
          .run(JSON.stringify({ reasonCodes: [error instanceof OperationsError ? error.code : "RESTORE_EXTERNAL_CHECK_FAILED"] }), this.now().toISOString(), operationId);
        throw error;
      }
    });
  }
  async confirmState(input: { operationId: string; evidenceId: string; expectedRevision: number }): Promise<RestoreCheckReceipt> {
    return this.options.withSnapshot(async () => {
      this.guard();
      const row = this.row(input.operationId); const evidence = row.evidence_json ? JSON.parse(row.evidence_json) as Evidence : undefined;
      if (!evidence || evidence.version !== 1 || evidence.id !== input.evidenceId || evidence.reasonCodes.length || row.revision !== input.expectedRevision
        || row.state !== "ready" || row.owner_context_json !== this.ownerContext()) throw new OperationsError("RESTORE_CHECK_STALE");
      if (Date.parse(evidence.validUntil) <= this.now().getTime() || evidence.digest !== jsonDigest({ binding: evidence.binding, observation: evidence.observation })) throw new OperationsError("RESTORE_CHECK_STALE");
      const binding = await this.binding();
      if (jsonDigest(binding) !== jsonDigest(evidence.binding)) throw new OperationsError("RESTORE_CHECK_STALE");
      const current = await this.options.inspectExternal(binding);
      if (this.reasons(binding, current).length || jsonDigest(current) !== jsonDigest(evidence.observation)) throw new OperationsError("RESTORE_CHECK_STALE");
      if (jsonDigest(binding) !== jsonDigest(await this.binding())) throw new OperationsError("RESTORE_CHECK_STALE");
      this.guard();
      return this.options.db.transaction(() => {
        const gate = readRestoreReadinessGate(this.options.db);
        if (jsonDigest(gate) !== binding.gateDigest || Date.parse(evidence.validUntil) <= this.now().getTime()) throw new OperationsError("RESTORE_CHECK_STALE");
        const changed = this.options.db.prepare("UPDATE host_execution_operations SET state='completed',revision=revision+1,result_json=?,updated_at=? WHERE id=? AND kind='restore_check' AND state='ready' AND revision=? AND evidence_json=?")
          .run(JSON.stringify({ reasonCodes: [], restoreGateReleased: true }), this.now().toISOString(), row.id, input.expectedRevision, row.evidence_json);
        if (changed.changes !== 1) throw new OperationsError("RESTORE_CHECK_STALE");
        this.options.db.prepare("DELETE FROM host_state WHERE key='restore_readiness'").run();
        return this.receipt(this.row(row.id));
      })();
    });
  }
  private row(id: string): Row {
    const row = this.options.db.prepare("SELECT * FROM host_execution_operations WHERE id=? AND kind='restore_check'").get(id) as Row | undefined;
    if (!row) throw new OperationsError("RESTORE_CHECK_NOT_FOUND"); return row;
  }
  private receipt(row: Row): RestoreCheckReceipt {
    const evidence = row.evidence_json ? JSON.parse(row.evidence_json) as Evidence : undefined;
    if (!evidence || !["ready", "rejected", "completed"].includes(row.state)) throw new OperationsError("RESTORE_CHECK_REINSPECTION_REQUIRED");
    return { operationId: row.id, evidenceId: evidence.id, revision: row.revision, state: row.state as RestoreCheckReceipt["state"], validUntil: evidence.validUntil, reasonCodes: evidence.reasonCodes };
  }
}

/** argv starts after `restore`; Main supplies the owned maintenance service. */
export async function runRestoreExternalCheckCli(argv: readonly string[], service: RestoreExternalCheckService): Promise<RestoreCheckReceipt> {
  if (argv[0] === "inspect-state" && argv.length === 2 && argv[1]) return service.inspectState({ commandId: argv[1] });
  if (argv[0] === "confirm-state" && argv.length === 4 && argv[1] && argv[2] && /^\d+$/.test(argv[3] ?? "")) {
    return service.confirmState({ operationId: argv[1], evidenceId: argv[2], expectedRevision: Number(argv[3]) });
  }
  throw new OperationsError("OPERATIONS_INVALID_COMMAND");
}

export { jsonDigest as restoreExternalBindingDigest };

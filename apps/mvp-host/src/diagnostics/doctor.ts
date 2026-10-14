import type Database from "better-sqlite3";
import { basename } from "node:path";
import { HostDiagnosticsSchema, UsageEvidenceSchema, type HostDiagnostics, type UsageEvidence, type VerifiedProviderEvidence } from "@flyx/mvp-protocol";
import { assertSupportedSchema, columns, hasTable, OperationsError, schemaVersions } from "../operations/operation-files.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { readRestoreReadinessGate } from "../operations/restore-service.js";

export interface DoctorContext {
  db: Database.Database;
  supportedSchemaVersion: number;
  access: { kind: "local" } | { kind: "remote"; scopes: ReadonlySet<string> };
  owner?: HostDiagnostics["owner"];
  readiness?: HostDiagnostics["readiness"];
  providers?: readonly (Omit<VerifiedProviderEvidence, "usage" | "executableName"> & { usage?: unknown; executable?: string })[];
  queues?: HostDiagnostics["queues"];
  relay?: HostDiagnostics["relay"];
  now?: () => Date;
}

/** Legacy costUsd (including Codex's synthetic zero) has no proven source. */
export function normalizeUsage(input: unknown): UsageEvidence {
  const parsed = UsageEvidenceSchema.safeParse(input);
  return parsed.success ? parsed.data : { source: "unknown", availability: "unavailable" };
}

function count(db: Database.Database, table: string, where = ""): number {
  if (!hasTable(db, table)) return 0;
  return (db.prepare("SELECT COUNT(*) AS count FROM " + table + where).get() as { count: number }).count;
}

function safeCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "DIAGNOSTIC_UNAVAILABLE";
}

export function collectDoctor(context: DoctorContext): HostDiagnostics {
  const hostAccess = context.access.kind === "local" || context.access.scopes.has("host:read");
  const sessionAccess = context.access.kind === "local" || context.access.scopes.has("session:read");
  if (!hostAccess) throw new OperationsError("FORBIDDEN");
  const schema = schemaVersions(context.db);
  const supportedVersion = Math.min(context.supportedSchemaVersion, SUPPORTED_SCHEMA_VERSION);
  let schemaFailure: string | undefined;
  try { assertSupportedSchema(context.db, supportedVersion); }
  catch (error) { schemaFailure = error instanceof OperationsError && error.code === "SCHEMA_TOO_NEW" ? "SCHEMA_TOO_NEW" : "SCHEMA_INVALID"; }
  const owner = context.owner ?? { mode: "read_only", state: "unverified" };
  const reasons = [...(context.readiness?.reasonCodes ?? [])].map(safeCode);
  let restore: ReturnType<typeof readRestoreReadinessGate>;
  let invalidRestore = false;
  try { restore = readRestoreReadinessGate(context.db); }
  catch { invalidRestore = true; reasons.push("RESTORE_GATE_INVALID"); }
  if (schemaFailure) reasons.push(schemaFailure);
  if (restore) reasons.push(...restore.reasonCodes);
  if (owner.state !== "active") reasons.push("HOST_OWNER_UNVERIFIED");
  const status = reasons.length > 0 ? "blocked" : owner.mode === "maintenance" ? "maintenance"
    : owner.mode === "read_only" ? "read_only" : context.readiness?.status ?? "blocked";
  const result: HostDiagnostics = {
    v: 1, generatedAt: (context.now ?? (() => new Date()))().toISOString(), owner,
    readiness: { status, reasonCodes: [...new Set(reasons)].slice(0, 32) },
    schema: { ...schema, supportedVersion, writable: !schemaFailure && !invalidRestore && !restore && status === "ready" && owner.mode === "runtime" && owner.state === "active" },
    providers: (context.providers ?? []).map(({ executable, usage, ...provider }) => ({
      ...provider, ...(executable ? { executableName: basename(executable).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) } : {}),
      usage: normalizeUsage(usage),
    })),
    relay: context.relay ?? { status: "unknown" },
  };
  if (sessionAccess && !schemaFailure) {
    result.activity = {
      activeTurns: count(context.db, "turns", " WHERE status IN ('queued', 'running', 'waiting_approval', 'interrupting')"),
      unknownTurns: count(context.db, "turns", " WHERE status = 'outcome_unknown'"),
      activeIntents: count(context.db, "execution_intents", " WHERE state IN ('pending', 'claimed', 'dispatching', 'acknowledged')"),
      unknownIntents: count(context.db, "execution_intents", " WHERE state = 'outcome_unknown'"),
    };
    result.queues = context.queues ?? { available: false };
    const head = hasTable(context.db, "sessions") ? context.db.prepare("SELECT COUNT(*) AS sessions, COALESCE(SUM(head_sequence), 0) AS head FROM sessions").get() as { sessions: number; head: number } : { sessions: 0, head: 0 };
    result.timeline = { available: hasTable(context.db, "timeline_epochs"), sessions: head.sessions, headSequence: head.head };
    if (result.timeline.available) {
      const indexed = context.db.prepare("SELECT COALESCE(SUM(indexed_sequence), 0) AS indexed FROM timeline_epochs WHERE state = 'active'").get() as { indexed: number };
      result.timeline.indexedSequence = indexed.indexed;
      result.timeline.lag = Math.max(0, head.head - indexed.indexed);
      result.timeline.buildingEpochs = count(context.db, "timeline_epochs", " WHERE state = 'building'");
    }
    result.content = { available: hasTable(context.db, "content_refs") };
    if (result.content.available) {
      const content = context.db.prepare("SELECT COUNT(*) AS refs, COALESCE(SUM(CASE WHEN state = 'ready' THEN byte_length ELSE 0 END), 0) AS bytes, COALESCE(SUM(CASE WHEN state = 'expired' THEN 1 ELSE 0 END), 0) AS expired FROM content_refs").get() as { refs: number; bytes: number; expired: number };
      const storage = hasTable(context.db, "content_storage_state") ? context.db.prepare("SELECT stored_bytes FROM content_storage_state WHERE id = 1").get() as { stored_bytes: number } | undefined : undefined;
      result.content = { available: true, refs: content.refs, logicalRefBytes: content.bytes, ...(storage ? { bytes: storage.stored_bytes } : {}), expiredRefs: content.expired };
    }
    // A missing checkpoint table is unavailable, never a claim of zero failures.
    const checkpointTable = ["checkpoint_captures", "checkpoint_operations", "checkpoints"].find((table) => hasTable(context.db, table) && columns(context.db, table).has("status"));
    result.checkpoints = checkpointTable ? { available: true, failed: count(context.db, checkpointTable, " WHERE status IN ('failed', 'partial_failure', 'capture_unavailable')") } : { available: false };
    if (checkpointTable === "checkpoint_captures") {
      result.checkpoints.unsupported = count(context.db, checkpointTable, " WHERE status = 'unsupported'");
      result.checkpoints.raced = count(context.db, checkpointTable, " WHERE status = 'raced'");
      result.checkpoints.legacyInexact = count(context.db, checkpointTable, " WHERE status = 'legacy_inexact'");
    }
    const revertColumns = hasTable(context.db, "checkpoint_revert_operations") ? columns(context.db, "checkpoint_revert_operations") : undefined;
    if (revertColumns?.has("stage") && revertColumns.has("status")) {
      const partial = count(context.db, "checkpoint_revert_operations", " WHERE stage = 'partial_failure'");
      result.checkpoints = { ...result.checkpoints, available: true, failed: (result.checkpoints.failed ?? 0) + partial };
      if (partial) reasons.push("CHECKPOINT_REVERT_PARTIAL_FAILURE");
      if (count(context.db, "checkpoint_revert_operations", " WHERE status IN ('blocked','queued','running')")) reasons.push("CHECKPOINT_REVERT_INCOMPLETE");
    }
    const revertGateColumns = hasTable(context.db, "checkpoint_revert_gates") ? columns(context.db, "checkpoint_revert_gates") : undefined;
    if (revertGateColumns?.has("state") && count(context.db, "checkpoint_revert_gates", " WHERE state = 'blocked'")) reasons.push("CHECKPOINT_REVERT_BLOCKED");
    if (reasons.length) { result.readiness = { status: "blocked", reasonCodes: [...new Set(reasons)].slice(0, 32) }; result.schema.writable = false; }
  }
  // Reconstruct from an allowlisted schema: no prose, paths, account metadata or secrets.
  return HostDiagnosticsSchema.parse(result);
}

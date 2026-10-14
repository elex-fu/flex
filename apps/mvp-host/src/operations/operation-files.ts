import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { assertHostOwner, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION, StoreSchemaError } from "../storage/migrations/schema-version.js";

/** The lifecycle owner is adapted to this narrow capability at the call site. */
export interface OperationOwner {
  readonly mode: "runtime" | "maintenance";
  readonly databasePath: string;
  assertActive(): void;
}

/** Identity rotation and Relay generation changes must use this same lane. */
export function operationOwnerFromHost(handle: HostOwnerHandle): OperationOwner {
  assertHostOwner(handle);
  return { mode: handle.mode === "maintenance" ? "maintenance" : "runtime", databasePath: handle.databasePath, assertActive: () => assertHostOwner(handle) };
}

export type SnapshotCoordinator = <T>(work: () => Promise<T>) => Promise<T>;

export class OperationsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperationsError";
  }
}

export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function assertPrivateDirectory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new OperationsError("OPERATIONS_UNSAFE_DIRECTORY");
  }
  return realpath(path);
}

export async function readPrivateFile(path: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new OperationsError("OPERATIONS_UNSAFE_FILE");
    }
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new OperationsError("OPERATIONS_FILE_TOO_LARGE");
    return bytes;
  } finally { await handle.close(); }
}

export async function writePrivateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function createBackupDirectory(path: string): Promise<string> {
  const destination = resolve(path);
  await assertPrivateDirectory(dirname(destination));
  await mkdir(destination, { mode: 0o700 });
  return assertPrivateDirectory(destination);
}

export async function bindOwner(owner: OperationOwner, databasePath: string): Promise<void> {
  owner.assertActive();
  if (await realpath(owner.databasePath) !== await realpath(databasePath)) throw new OperationsError("OPERATIONS_OWNER_MISMATCH");
}

export function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

export function columns(db: Database.Database, table: string): Set<string> {
  // Names are compile-time constants supplied by this module's callers.
  if (!/^[a-z_]+$/.test(table)) throw new OperationsError("OPERATIONS_SCHEMA_INVALID");
  return new Set((db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: string }>).map((row) => row.name));
}

export function schemaVersions(db: Database.Database): { migrationVersion: number; userVersion: number } {
  if (!hasTable(db, "schema_migrations")) throw new OperationsError("BACKUP_SCHEMA_INVALID");
  const migration = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  if (!Number.isSafeInteger(migration.version) || !Number.isSafeInteger(userVersion) || migration.version < 1 || userVersion < 0) {
    throw new OperationsError("BACKUP_SCHEMA_INVALID");
  }
  return { migrationVersion: migration.version, userVersion };
}

export function assertSupportedSchema(db: Database.Database, supportedVersion: number): ReturnType<typeof schemaVersions> {
  if (!Number.isSafeInteger(supportedVersion) || supportedVersion < 1) throw new OperationsError("BACKUP_SCHEMA_INVALID");
  try { inspectSchema(db, { maximumVersion: Math.min(supportedVersion, SUPPORTED_SCHEMA_VERSION) }); }
  catch (error) {
    if (error instanceof StoreSchemaError && error.code === "FUTURE_SCHEMA") throw new OperationsError("SCHEMA_TOO_NEW");
    throw new OperationsError("BACKUP_SCHEMA_INVALID");
  }
  return schemaVersions(db);
}

export function identityMirror(db: Database.Database): { hostId: string; fingerprint: string } {
  const row = db.prepare("SELECT value_json FROM host_state WHERE key = 'host_identity'").get() as { value_json: string } | undefined;
  let value: unknown;
  try { value = row ? JSON.parse(row.value_json) : undefined; } catch { throw new OperationsError("BACKUP_IDENTITY_MISMATCH"); }
  if (!value || typeof value !== "object" || !("hostId" in value) || !("fingerprint" in value)
    || typeof value.hostId !== "string" || typeof value.fingerprint !== "string") {
    throw new OperationsError("BACKUP_IDENTITY_MISMATCH");
  }
  return { hostId: value.hostId, fingerprint: value.fingerprint };
}

export async function privateDatabaseFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new OperationsError("OPERATIONS_UNSAFE_FILE");
    await handle.chmod(0o600);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Checks content bytes, including references whose lengths and FKs still look valid. */
export function validateContentReferences(db: Database.Database): number {
  if (!hasTable(db, "content_refs")) return 0;
  const required = ["id", "session_id", "kind", "state", "stream_id", "through_sequence", "byte_length", "sha256", "blob_data"];
  const available = columns(db, "content_refs");
  if (required.some((column) => !available.has(column))) throw new OperationsError("BACKUP_CONTENT_SCHEMA_UNSUPPORTED");
  type Ref = { id: string; session_id: string; kind: string; state: string; stream_id: string | null; through_sequence: number | null; byte_length: number; sha256: string; blob_data: Buffer | null };
  const refs = db.prepare("SELECT * FROM content_refs").iterate() as Iterable<Ref>;
  let checked = 0;
  for (const ref of refs) {
    if (!Number.isSafeInteger(ref.byte_length) || ref.byte_length < 0 || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new OperationsError("BACKUP_CONTENT_INVALID");
    if (ref.state === "expired") continue;
    if (ref.state !== "ready") throw new OperationsError("BACKUP_CONTENT_INVALID");
    const hash = createHash("sha256");
    let length = 0;
    if (ref.kind === "blob") {
      if (!Buffer.isBuffer(ref.blob_data) || ref.stream_id !== null) throw new OperationsError("BACKUP_CONTENT_INVALID");
      hash.update(ref.blob_data);
      length = ref.blob_data.length;
    } else if (ref.kind === "stream_prefix") {
      if (!hasTable(db, "content_streams") || !hasTable(db, "content_segments") || ref.stream_id === null || ref.through_sequence === null) throw new OperationsError("BACKUP_CONTENT_INVALID");
      const stream = db.prepare("SELECT session_id FROM content_streams WHERE id = ?").get(ref.stream_id) as { session_id: string } | undefined;
      if (stream?.session_id !== ref.session_id) throw new OperationsError("BACKUP_CONTENT_INVALID");
      const segments = db.prepare("SELECT byte_start, byte_end, data FROM content_segments WHERE stream_id = ? AND source_sequence <= ? ORDER BY byte_start")
        .iterate(ref.stream_id, ref.through_sequence) as Iterable<{ byte_start: number; byte_end: number; data: Buffer }>;
      for (const segment of segments) {
        if (length === ref.byte_length) break;
        if (segment.byte_start !== length || !Buffer.isBuffer(segment.data) || segment.byte_end !== length + segment.data.length || segment.data.length === 0) throw new OperationsError("BACKUP_CONTENT_INVALID");
        const end = Math.min(segment.byte_end, ref.byte_length);
        hash.update(segment.data.subarray(0, end - length));
        length = end;
      }
    } else throw new OperationsError("BACKUP_CONTENT_INVALID");
    if (length !== ref.byte_length || hash.digest("hex") !== ref.sha256) throw new OperationsError("BACKUP_CONTENT_INVALID");
    checked += 1;
  }
  return checked;
}

export function validateDatabase(db: Database.Database, supportedVersion: number): { schema: ReturnType<typeof schemaVersions>; checkedContentRefs: number } {
  const schema = assertSupportedSchema(db, supportedVersion);
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new OperationsError("BACKUP_INTEGRITY_FAILED");
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) throw new OperationsError("BACKUP_FOREIGN_KEYS_FAILED");
  return { schema, checkedContentRefs: validateContentReferences(db) };
}

export async function fileDigest(path: string): Promise<string> {
  // Large database snapshots are read as streams to avoid holding them in memory.
  const { createReadStream } = await import("node:fs");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new OperationsError("OPERATIONS_UNSAFE_FILE");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path, { fd: handle.fd, autoClose: false })) hash.update(bytes as Buffer);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

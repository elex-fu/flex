import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const CATALOG_SCHEMA_VERSION = 7;
export const CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL, worktree_root TEXT NOT NULL, checkout_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','worktree')), state TEXT NOT NULL CHECK(state IN ('active','needs_verification','disabled')),
  repository_id TEXT NOT NULL, capabilities_json TEXT NOT NULL, registration_operation_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(canonical_root)
);
CREATE TABLE IF NOT EXISTS provider_instances (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), executable TEXT NOT NULL,
  config_json TEXT NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  state TEXT NOT NULL CHECK(state IN ('configured','unconfigured','disabled')),
  verification_json TEXT NOT NULL, policy_capabilities_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_catalog (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances(id), title TEXT NOT NULL,
  native_handle_json TEXT, residency_state TEXT NOT NULL DEFAULT 'unloaded' CHECK(residency_state IN ('unloaded','loading','loaded','closing','blocked')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS session_catalog_provider ON session_catalog(provider_instance_id,session_id);
CREATE INDEX IF NOT EXISTS sessions_workspace_catalog ON sessions(workspace_id,status,id);
CREATE TABLE IF NOT EXISTS catalog_runtime_operations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), auth_subject_id TEXT NOT NULL, command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_format_version INTEGER NOT NULL CHECK(request_format_version = 2),
  owner_context_json TEXT NOT NULL, runtime_id TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','completed','outcome_unknown')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(auth_subject_id,command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_catalog_runtime_close ON catalog_runtime_operations(session_id) WHERE state <> 'completed';
CREATE TABLE IF NOT EXISTS catalog_import_manifests (
  id TEXT PRIMARY KEY, source_digest TEXT NOT NULL UNIQUE, source_schema_version INTEGER NOT NULL,
  source_host_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL, target_backup_path TEXT NOT NULL,
  source_backup_path TEXT NOT NULL, counts_json TEXT NOT NULL, imported_at TEXT NOT NULL
);
`;

export const legacyWorkspaceId = (root: string) => `workspace-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
export const legacyProviderInstanceId = (provider: string) => `legacy-provider-${provider}`;
export const checkoutKey = (worktreeRoot: string) => createHash("sha256").update(worktreeRoot).digest("hex");

export function validateCatalogSchema(db: Database.Database): void {
  for (const [table, names] of Object.entries({
    workspaces: ["id","canonical_root","worktree_root","checkout_key","kind","state","repository_id","capabilities_json","registration_operation_id","created_at","updated_at"],
    provider_instances: ["id","provider","executable","config_json","policy_version","state","verification_json","policy_capabilities_json","created_at","updated_at"],
    session_catalog: ["session_id","provider_instance_id","title","native_handle_json","residency_state","archived_at"],
    catalog_runtime_operations:["id","session_id","auth_subject_id","command_id","request_hash","request_format_version","owner_context_json","runtime_id","state","created_at","updated_at"],
    catalog_import_manifests: ["id","source_digest","source_schema_version","source_host_id","source_fingerprint","target_backup_path","source_backup_path","counts_json","imported_at"],
  })) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;
    if (names.some((name) => !columns.some((column) => column.name === name))) throw new Error(`SCHEMA_INVALID: catalog ${table}`);
  }
  for(const [table,primary] of Object.entries({workspaces:["id"],provider_instances:["id"],session_catalog:["session_id"],catalog_runtime_operations:["id"],catalog_import_manifests:["id"]})) {
    const columns=db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string;pk:number}>;
    if(columns.filter((column)=>column.pk>0).sort((a,b)=>a.pk-b.pk).map((column)=>column.name).join(",")!==primary.join(","))throw new Error(`SCHEMA_INVALID: catalog ${table} key`);
  }
  for(const [table,unique,partial] of [["workspaces",["canonical_root"],false],["catalog_import_manifests",["source_digest"],false],["catalog_runtime_operations",["auth_subject_id","command_id"],false],["catalog_runtime_operations",["session_id"],true]] as const) {
    const indexes=db.prepare(`PRAGMA index_list(${table})`).all() as Array<{name:string;unique:number;partial:number}>;
    if(!indexes.some((index)=>index.unique&&Boolean(index.partial)===partial&&(db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as Array<{name:string}>).map((column)=>column.name).join(",")===unique.join(",")))throw new Error(`SCHEMA_INVALID: catalog ${table} uniqueness`);
  }
  for(const [table,column,parent,to] of [["session_catalog","session_id","sessions","id"],["session_catalog","provider_instance_id","provider_instances","id"],["catalog_runtime_operations","session_id","sessions","id"]]) {
    const refs=db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{from:string;table:string;to:string}>;
    if(!refs.some((reference)=>reference.from===column&&reference.table===parent&&reference.to===to))throw new Error(`SCHEMA_INVALID: catalog ${table} relation`);
  }
  const closeIndex=db.prepare("SELECT sql FROM sqlite_master WHERE name='one_catalog_runtime_close'").get() as {sql:string}|undefined;
  if(!closeIndex?.sql.toLowerCase().replace(/[\s"`\[\]]/g,"").endsWith("wherestate<>'completed'"))throw new Error("SCHEMA_INVALID: catalog close admission index");
  const invalid=db.prepare(`SELECT 1 FROM session_catalog c JOIN sessions s ON s.id=c.session_id
    LEFT JOIN workspaces w ON w.id=s.workspace_id LEFT JOIN provider_instances p ON p.id=c.provider_instance_id
    WHERE w.id IS NULL OR p.id IS NULL OR p.provider<>s.provider LIMIT 1`).get();
  if(invalid)throw new Error("SCHEMA_INVALID: catalog Session binding");
}

/** SQL-only; legacy paths remain unverified until matched by local Host config. */
export function applyCatalogMigration(db: Database.Database, at = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get()) { validateCatalogSchema(db); return; }
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{name:string}>;
    if (!columns.some((column) => column.name === "revision")) throw new Error("CATALOG_REQUIRES_COMMAND_SCHEMA");
    db.exec(CATALOG_SCHEMA_SQL);
    const rows = db.prepare("SELECT id,workspace_id,workspace_path,provider,provider_session_id,status FROM sessions ORDER BY created_at,id").all() as Array<{id:string;workspace_id:string;workspace_path:string;provider:string;provider_session_id:string|null;status:string}>;
    for (const row of rows) {
      if (row.provider !== "claude" && row.provider !== "codex") throw new Error("CATALOG_PROVIDER_UNKNOWN");
      const workspaceId = row.workspace_id === "default" ? legacyWorkspaceId(row.workspace_path) : row.workspace_id;
      const instanceId = legacyProviderInstanceId(row.provider);
      db.prepare("INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?, 'local','needs_verification',?, '[]',NULL,?,?)").run(workspaceId,row.workspace_path,row.workspace_path,checkoutKey(row.workspace_path),workspaceId,at,at);
      const workspace=db.prepare("SELECT canonical_root FROM workspaces WHERE id=?").get(workspaceId) as {canonical_root:string}|undefined;
      if(!workspace||workspace.canonical_root!==row.workspace_path)throw new Error("CATALOG_WORKSPACE_CONFLICT");
      db.prepare("INSERT OR IGNORE INTO provider_instances VALUES(?,?, '', '{}',1,'unconfigured','{\"state\":\"unverified\",\"capabilities\":[]}', '[]',?,?)").run(instanceId,row.provider,at,at);
      db.prepare("UPDATE sessions SET workspace_id=? WHERE id=?").run(workspaceId,row.id);
      const handle = row.provider_session_id ? JSON.stringify({v:1,provider:row.provider,providerInstanceId:instanceId,workspaceId,nativeSessionId:row.provider_session_id,provenance:"legacy"}) : null;
      db.prepare("INSERT OR IGNORE INTO session_catalog VALUES(?,?,?,?,'unloaded',?)").run(row.id,instanceId,"Untitled session",handle,row.status === "archived" ? at : null);
    }
    const existing = db.prepare("SELECT value_json FROM host_state WHERE key='legacyDefaultSessionId'").get();
    const active = rows.filter((row) => row.status === "active");
    if (!existing && active.length === 1) db.prepare("INSERT INTO host_state VALUES('legacyDefaultSessionId',?,?)").run(JSON.stringify(active[0]!.id),at);
    db.prepare("INSERT INTO schema_migrations VALUES(7,?)").run(at);
    validateCatalogSchema(db);
  })();
}

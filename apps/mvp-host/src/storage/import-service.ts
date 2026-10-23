import Database from "better-sqlite3";
import { createHash,randomUUID } from "node:crypto";
import { mkdirSync,realpathSync,statSync } from "node:fs";
import { join } from "node:path";
import {SessionNativeHandleSchema,type ProviderId} from "@flyx/mvp-protocol";
import { ExclusiveFileLock,assertHostOwner,assertWorkspacePrivacy,defaultCoordinationDirectory,type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { SystemProcessInspector } from "../lifecycle/process-inspector.js";
import { CatalogError,CatalogStore,type WorkspaceRecord,type ProviderInstanceRecord } from "./catalog-store.js";
import { inspectSchema } from "./migrations/schema-version.js";
import { validateCatalogSchema } from "./migrations/007-catalog.js";
import type { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import type { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";

type Row=Record<string,string|number|bigint|Buffer|null>;
const FACT_TABLES=["sessions","turns","event_commits","session_events","timeline_items","approvals","command_receipts","execution_intents","approval_reservations","native_turn_bindings","native_terminal_receipts","managed_processes","managed_process_identities","managed_process_boundaries","managed_process_stop_proofs","recovery_evidence","recovery_operations","content_streams","content_segments","content_refs","content_pins","timeline_epochs","timeline_item_versions","timeline_item_sources","interactions","interaction_reservations","interaction_delivery_evidence","checkpoint_captures","checkpoint_files","checkpoint_baselines","checkpoint_diffs","checkpoint_diff_files","checkpoint_preview_plans","checkpoint_pins","catalog_runtime_operations"] as const;
const AUTH_TABLES=new Set(["auth_sessions","pairing_grants","devices","protocol_sessions","access_audit_events"]);
const INTERNAL_TABLES=new Set(["schema_migrations","host_state","workspaces","provider_instances","session_catalog","catalog_import_manifests","content_storage_state"]);
export type CatalogImportInput={sourceDatabasePath:string;legacyWorkspaceByCanonicalRoot?:Readonly<Record<string,string>>;legacyProviderInstances?:Readonly<Partial<Record<ProviderId,string>>>};
export type CatalogImportPlan={planId:string;sourceDatabasePath:string;sourceDigest:string;sourceSchemaVersion:number;sourceHostId:string;sourceFingerprint:string;sessionIds:readonly string[];counts:Readonly<Record<string,number>>;alreadyImported:boolean};
type Binding={sessionId:string;workspace:WorkspaceRecord;provider:ProviderInstanceRecord;catalog:Row;blocked:boolean};
type Snapshot={version:number;hostId:string;fingerprint:string;facts:Map<string,Row[]>;bindings:Binding[];digest:string;counts:Record<string,number>};
export type CatalogImportResult={manifestId:string;sessionIds:readonly string[];sourceBackupPath:string;targetBackupPath:string;reused:boolean};

/** Local offline import only: source is readonly; authorization tables never enter the target. */
export class CatalogImportService {
  private readonly plans=new WeakMap<object,CatalogImportInput>();
  private busy=false;
  constructor(readonly catalog:CatalogStore,private readonly workspaces:WorkspaceRegistry,private readonly providers:ProviderInstanceRegistry,private readonly options:{owner:HostOwnerHandle;backupDirectory:string}) {}
  private assertMaintenance():void {
    assertHostOwner(this.options.owner);
    if(this.options.owner.mode!=="maintenance"||this.options.owner.recoveryOnly)throw new CatalogError("OFFLINE_MAINTENANCE_REQUIRED");
    this.catalog.store.assertWriterOwner();
    for(const session of this.catalog.allSessions()) {
      this.catalog.assertIdle(session.sessionId);
      if(session.residency!=="unloaded")throw new CatalogError("SESSION_RUNTIME_LOADED");
    }
  }
  private source<T>(input:CatalogImportInput,work:(db:Database.Database,path:string)=>T):T {
    this.assertMaintenance();
    const path=realpathSync(input.sourceDatabasePath);
    if(path===this.options.owner.databasePath)throw new CatalogError("IMPORT_SOURCE_EQUALS_TARGET");
    const lock=ExclusiveFileLock.acquire({directory:this.options.owner.coordinationDirectory??defaultCoordinationDirectory(),resourceKey:`db:${path}`,ownerId:this.options.owner.ownerId,ownerGeneration:this.options.owner.generation,purpose:"catalog-import-source",inspector:new SystemProcessInspector()});
    let db:Database.Database|undefined;
    try {db=new Database(path,{readonly:true,fileMustExist:true});return work(db,path);}
    finally {db?.close();lock.release();}
  }
  dryRun(input:CatalogImportInput):CatalogImportPlan {
    const copied={sourceDatabasePath:input.sourceDatabasePath,...(input.legacyWorkspaceByCanonicalRoot?{legacyWorkspaceByCanonicalRoot:{...input.legacyWorkspaceByCanonicalRoot}}:{}),...(input.legacyProviderInstances?{legacyProviderInstances:{...input.legacyProviderInstances}}:{})};
    const plan=this.source(copied,(db,path)=>{
      const snapshot=this.snapshot(db,copied);
      const already=this.manifest(snapshot.digest);
      if(!already)this.assertNoConflicts(snapshot);
      return Object.freeze({planId:randomUUID(),sourceDatabasePath:path,sourceDigest:snapshot.digest,sourceSchemaVersion:snapshot.version,sourceHostId:snapshot.hostId,sourceFingerprint:snapshot.fingerprint,sessionIds:Object.freeze(snapshot.bindings.map((binding)=>binding.sessionId)),counts:Object.freeze(snapshot.counts),alreadyImported:Boolean(already)});
    });
    this.plans.set(plan,copied);return plan;
  }
  async import(plan:CatalogImportPlan):Promise<CatalogImportResult> {
    const input=this.plans.get(plan);if(!input)throw new CatalogError("IMPORT_DRY_RUN_REQUIRED");
    if(this.busy)throw new CatalogError("IMPORT_BUSY",undefined,true);
    this.busy=true;
    let source:Database.Database|undefined;let lock:ExclusiveFileLock|undefined;
    try {
      this.assertMaintenance();
      const path=realpathSync(input.sourceDatabasePath);if(path!==plan.sourceDatabasePath)throw new CatalogError("IMPORT_SOURCE_CHANGED");
      const identity=statSync(path);
      lock=ExclusiveFileLock.acquire({directory:this.options.owner.coordinationDirectory??defaultCoordinationDirectory(),resourceKey:`db:${path}`,ownerId:this.options.owner.ownerId,ownerGeneration:this.options.owner.generation,purpose:`catalog-import:${plan.planId}`,inspector:new SystemProcessInspector()});
      source=new Database(path,{readonly:true,fileMustExist:true});
      const snapshot=this.snapshot(source,input);
      if(snapshot.digest!==plan.sourceDigest)throw new CatalogError("IMPORT_SOURCE_CHANGED","Source facts changed after dry-run; review a new plan");
      const existing=this.manifest(snapshot.digest);if(existing)return {manifestId:existing.id,sessionIds:plan.sessionIds,sourceBackupPath:existing.source_backup_path,targetBackupPath:existing.target_backup_path,reused:true};
      this.assertNoConflicts(snapshot);
      mkdirSync(this.options.backupDirectory,{recursive:true,mode:0o700});
      const backupDirectory=realpathSync(this.options.backupDirectory);
      for(const workspace of this.catalog.workspaces()) {assertWorkspacePrivacy(workspace.canonicalRoot,[backupDirectory]);assertWorkspacePrivacy(workspace.worktreeRoot,[backupDirectory]);}
      const sourceBackupPath=join(backupDirectory,`source-${plan.planId}.sqlite`);
      const targetBackupPath=join(backupDirectory,`target-${plan.planId}.sqlite`);
      await source.backup(sourceBackupPath);
      await this.catalog.db.backup(targetBackupPath);
      const current=statSync(path);
      if(current.dev!==identity.dev||current.ino!==identity.ino||this.snapshot(source,input).digest!==snapshot.digest)throw new CatalogError("IMPORT_SOURCE_CHANGED");
      this.assertMaintenance();
      const manifestId=randomUUID();
      this.catalog.db.transaction(()=>{
        this.assertNoConflicts(snapshot);
        this.catalog.db.pragma("defer_foreign_keys = ON");
        for(const [table,rows] of snapshot.facts)for(const row of rows)this.insert(table,row);
        for(const binding of snapshot.bindings) {
          this.catalog.db.prepare("UPDATE sessions SET workspace_id=? WHERE id=?").run(binding.workspace.workspaceId,binding.sessionId);
          this.insert("session_catalog",binding.catalog);
          if(binding.blocked) {
            const names=this.columns(this.catalog.db,"sessions");
            if(names.includes("recovery_state"))this.catalog.db.prepare("UPDATE sessions SET recovery_state='blocked' WHERE id=?").run(binding.sessionId);
          }
        }
        if(this.table(this.catalog.db,"content_storage_state"))this.catalog.db.exec(`UPDATE content_storage_state SET stored_bytes=(SELECT COALESCE(SUM(length(data)),0) FROM content_segments)+(SELECT COALESCE(SUM(length(blob_data)),0) FROM content_refs)+(SELECT COALESCE(SUM(MAX(0,length(CAST(pending_text AS BLOB))-2)),0) FROM content_streams) WHERE id=1`);
        if((this.catalog.db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length)throw new CatalogError("IMPORT_REFERENCE_CONFLICT");
        this.catalog.db.prepare("INSERT INTO catalog_import_manifests VALUES(?,?,?,?,?,?,?,?,?)").run(manifestId,snapshot.digest,snapshot.version,snapshot.hostId,snapshot.fingerprint,targetBackupPath,sourceBackupPath,JSON.stringify(snapshot.counts),new Date().toISOString());
        this.options.owner.assertActive();
      })();
      return {manifestId,sessionIds:plan.sessionIds,sourceBackupPath,targetBackupPath,reused:false};
    } finally {source?.close();lock?.release();this.busy=false;}
  }
  private manifest(digest:string) {return this.catalog.db.prepare("SELECT id,source_backup_path,target_backup_path FROM catalog_import_manifests WHERE source_digest=?").get(digest) as {id:string;source_backup_path:string;target_backup_path:string}|undefined;}
  private table(db:Database.Database,name:string):boolean {return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
  private columns(db:Database.Database,table:string):string[] {return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string}>).map((column)=>column.name);}
  private snapshot(db:Database.Database,input:CatalogImportInput):Snapshot {
    return db.transaction(()=>{
      const targetVersion=(this.catalog.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {version:number}).version;
      const inspection=inspectSchema(db,{maximumVersion:targetVersion});
      if(inspection.version<3)throw new CatalogError("IMPORT_SOURCE_UPGRADE_REQUIRED","Upgrade source metadata offline before importing");
      if(inspection.version>=7)validateCatalogSchema(db);
      const mirror=db.prepare("SELECT value_json FROM host_state WHERE key='host_identity'").get() as {value_json:string}|undefined;
      const target=this.catalog.store.getHostIdentityMirror();
      const parsed=mirror?JSON.parse(mirror.value_json) as {hostId?:unknown;fingerprint?:unknown}:undefined;
      if(!target||typeof parsed?.hostId!=="string"||typeof parsed.fingerprint!=="string"||target.hostId!==parsed.hostId||target.fingerprint!==parsed.fingerprint)throw new CatalogError("IMPORT_HOST_IDENTITY_MISMATCH");
      const facts=new Map<string,Row[]>();const counts:Record<string,number>={};
      for(const table of FACT_TABLES)if(this.table(db,table)) {
        const rows=db.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[];
        if(!rows.length)continue;
        if(!this.table(this.catalog.db,table))throw new CatalogError("IMPORT_TARGET_SCHEMA_MISSING",`Target has no ${table} fact table`);
        const columns=this.columns(this.catalog.db,table);
        if(Object.keys(rows[0]!).some((column)=>!columns.includes(column)))throw new CatalogError("IMPORT_SCHEMA_MISMATCH",`Target cannot preserve ${table} fields`);
        facts.set(table,rows);counts[table]=rows.length;
      }
      const other=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>;
      for(const {name} of other)if(!AUTH_TABLES.has(name)&&!INTERNAL_TABLES.has(name)&&!FACT_TABLES.includes(name as typeof FACT_TABLES[number])) {
        const references=db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as Array<{table:string}>;
        const related=this.columns(db,name).includes("session_id")||references.some((reference)=>FACT_TABLES.includes(reference.table as typeof FACT_TABLES[number]));
        if(related&&db.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get())throw new CatalogError("IMPORT_UNSUPPORTED_FACT_TABLE",`Cannot silently discard ${name}`);
      }
      const sessions=facts.get("sessions")??[];
      const sourceCatalog=this.table(db,"session_catalog")?db.prepare("SELECT * FROM session_catalog").all() as Row[]:[];
      const bindings:Binding[]=sessions.map((session)=>{
        const id=String(session.id);const provider=session.provider;
        if(provider!=="claude"&&provider!=="codex")throw new CatalogError("IMPORT_PROVIDER_UNKNOWN");
        const source=sourceCatalog.find((row)=>row.session_id===id);
        const canonicalRoot=realpathSync(String(session.workspace_path));
        if(canonicalRoot!==session.workspace_path)throw new CatalogError("IMPORT_BINDING_MISMATCH","Source workspace path must be verified canonically before importing");
        const workspaceId=source?String(session.workspace_id):input.legacyWorkspaceByCanonicalRoot?.[canonicalRoot];
        const providerInstanceId=source?String(source.provider_instance_id):input.legacyProviderInstances?.[provider];
        if(!workspaceId||!providerInstanceId)throw new CatalogError("IMPORT_BINDING_REQUIRED","Every source Session needs explicit configured workspace and Provider ownership");
        const workspace=this.workspaces.require(workspaceId);const instance=this.providers.require(providerInstanceId);
        if(workspace.canonicalRoot!==canonicalRoot||instance.provider!==provider)throw new CatalogError("IMPORT_BINDING_MISMATCH");
        if(source) {
          const oldWorkspace=db.prepare("SELECT canonical_root,worktree_root,checkout_key FROM workspaces WHERE id=?").get(workspaceId) as {canonical_root:string;worktree_root:string;checkout_key:string}|undefined;
          const oldProvider=db.prepare("SELECT provider,executable,config_json,policy_version FROM provider_instances WHERE id=?").get(providerInstanceId) as {provider:string;executable:string;config_json:string;policy_version:number}|undefined;
          if(!oldWorkspace||oldWorkspace.canonical_root!==workspace.canonicalRoot||oldWorkspace.worktree_root!==workspace.worktreeRoot||oldWorkspace.checkout_key!==workspace.checkoutKey||!oldProvider||oldProvider.provider!==instance.provider||oldProvider.executable!==instance.executable||oldProvider.config_json!==JSON.stringify(instance.config)||oldProvider.policy_version!==instance.policyVersion)throw new CatalogError("IMPORT_BINDING_MISMATCH");
          if(source.native_handle_json) {
            const handle=SessionNativeHandleSchema.safeParse(JSON.parse(String(source.native_handle_json)) as unknown);
            if(!handle.success||handle.data.provider!==provider||handle.data.providerInstanceId!==providerInstanceId||handle.data.workspaceId!==workspaceId||handle.data.nativeSessionId!==session.provider_session_id)throw new CatalogError("IMPORT_BINDING_MISMATCH");
          }
        }
        const pending=(facts.get("execution_intents")??[]).some((row)=>row.session_id===id&&row.state!=="settled");
        const blocked=session.activity_state!=="idle"||session.recovery_state==="blocked"||Boolean(session.active_turn_id)||pending||(source&&source.residency_state!=="unloaded");
        const catalog:Row=source?{...source,residency_state:blocked?"blocked":"unloaded"}:{session_id:id,provider_instance_id:providerInstanceId,title:"Imported session",native_handle_json:session.provider_session_id?JSON.stringify({v:1,provider,providerInstanceId,workspaceId,nativeSessionId:session.provider_session_id,provenance:"legacy"}):null,residency_state:blocked?"blocked":"unloaded",archived_at:session.status==="archived"?session.updated_at??null:null};
        return {sessionId:id,workspace,provider:instance,catalog,blocked:Boolean(blocked)};
      });
      counts.session_catalog=bindings.length;
      // Stable digest includes actor receipts and immutable fact bytes, but not authority tables.
      const digest=createHash("sha256").update(JSON.stringify({version:inspection.version,hostId:parsed.hostId,fingerprint:parsed.fingerprint,facts:[...facts].map(([table,rows])=>[table,rows.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]),catalog:bindings.map((binding)=>({catalog:stable(binding.catalog),workspaceId:binding.workspace.workspaceId,canonicalRoot:binding.workspace.canonicalRoot,worktreeRoot:binding.workspace.worktreeRoot,checkoutKey:binding.workspace.checkoutKey,providerInstanceId:binding.provider.providerInstanceId,executable:binding.provider.executable,config:binding.provider.config,policyVersion:binding.provider.policyVersion})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})).digest("hex");
      return {version:inspection.version,hostId:parsed.hostId,fingerprint:parsed.fingerprint,facts,bindings,digest,counts};
    })();
  }
  private assertNoConflicts(snapshot:Snapshot):void {
    for(const [table,rows] of snapshot.facts) {
      const keys=(this.catalog.db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{name:string;pk:number}>).filter((column)=>column.pk>0).sort((a,b)=>a.pk-b.pk).map((column)=>column.name);
      if(!keys.length)throw new CatalogError("IMPORT_SCHEMA_MISMATCH",`No preserved key for ${table}`);
      const existing=this.catalog.db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${keys.map((key)=>`${quote(key)} IS ?`).join(" AND ")} LIMIT 1`);
      for(const row of rows)if(existing.get(...keys.map((key)=>row[key]??null)))throw new CatalogError("IMPORT_ID_CONFLICT",`Conflicting ${table} identity; import aborted without merging facts`);
    }
  }
  private insert(table:string,row:Row):void {
    const columns=Object.keys(row);this.catalog.db.prepare(`INSERT INTO ${quote(table)}(${columns.map(quote).join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...columns.map((column)=>row[column]??null));
  }
}
function quote(value:string):string {if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new CatalogError("IMPORT_SCHEMA_MISMATCH");return `"${value}"`;}
function stable(row:Row) {return Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,Buffer.isBuffer(value)?{base64:value.toString("base64")}:typeof value==="bigint"?value.toString():value]));}

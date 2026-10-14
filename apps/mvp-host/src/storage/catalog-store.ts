import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SessionNativeHandleSchema, type SessionNativeHandle, type SessionResidency, type SessionSummaryV2, type SessionEvent, type ProviderId } from "@flyx/mvp-protocol";
import type { SqliteStore } from "./db.js";
import { validateCatalogSchema } from "./migrations/007-catalog.js";

export class CatalogError extends Error {
  constructor(readonly code: string, message = code, readonly retryable = false) { super(message); this.name = "CatalogError"; }
}
export type WorkspaceRecord = {
  workspaceId: string; canonicalRoot: string; worktreeRoot: string; checkoutKey: string;
  kind: "local" | "worktree"; state: "active" | "needs_verification" | "disabled"; repositoryId: string;
  capabilities: string[]; registrationOperationId?: string; createdAt: string; updatedAt: string;
};
export type ProviderConfiguration = { model?: string; environment: Record<string,string>; sandboxRequired: true };
export type ProviderVerification = { state: "unverified" | "verified" | "unsupported"; runtimeVersion?: string; capabilities: string[] };
export type ProviderInstanceRecord = {
  providerInstanceId: string; provider: ProviderId; executable: string; config: ProviderConfiguration;
  policyVersion: number; state: "configured" | "unconfigured" | "disabled"; verification: ProviderVerification;
  policyCapabilities: string[]; createdAt: string; updatedAt: string;
};
export type CatalogSession = SessionSummaryV2 & { nativeHandle?: SessionNativeHandle };
export type CatalogCommand = { authSubjectId: string; commandId: string };
export type CatalogCommit = { summary: SessionSummaryV2; events: SessionEvent[]; reused: boolean };
export type RuntimeCloseOwnerContext={ownerId:string;ownerGeneration:number;resourceKeys:readonly string[]};
export type RuntimeCloseOperation = {id:string;sessionId:string;authSubjectId:string;commandId:string;requestHash:string;ownerContext:RuntimeCloseOwnerContext;runtimeId?:string;state:"accepted"|"completed"|"outcome_unknown";createdAt:string;updatedAt:string};
export type CatalogCloseCommit = CatalogCommit & {operation:RuntimeCloseOperation};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
  return value;
}
export function hashCatalogRequest(method: string, payload: unknown, context: {sessionId?:string;workspaceId:string;providerInstanceId:string;provider:ProviderId}): string {
  return createHash("sha256").update(JSON.stringify(canonical({requestFormatVersion:2,method,payload,context}))).digest("hex");
}
export const publicSessionSummary = ({ nativeHandle: _handle, ...summary }: CatalogSession): SessionSummaryV2 => summary;
type RawWorkspace = {id:string;canonical_root:string;worktree_root:string;checkout_key:string;kind:WorkspaceRecord["kind"];state:WorkspaceRecord["state"];repository_id:string;capabilities_json:string;registration_operation_id:string|null;created_at:string;updated_at:string};
type RawProvider = {id:string;provider:ProviderId;executable:string;config_json:string;policy_version:number;state:ProviderInstanceRecord["state"];verification_json:string;policy_capabilities_json:string;created_at:string;updated_at:string};
type RawSession = {id:string;workspace_id:string;provider_instance_id:string;provider:ProviderId;title:string;status:SessionSummaryV2["status"];activity_state:SessionSummaryV2["activityState"];head_sequence:number;revision:number;residency_state:SessionResidency;native_handle_json:string|null;created_at:string;updated_at:string};

export class CatalogStore {
  private readonly removeNativeProjection:()=>void;
  static isAvailable(db:Database.Database):boolean {try{validateCatalogSchema(db);return true;}catch{return false;}}
  constructor(readonly store: SqliteStore,private readonly options:{restoreWriteReady?:(db:Database.Database)=>void}={}) {
    validateCatalogSchema(store.db);
    this.removeNativeProjection=store.registerProjectionHook((sessionId,_event,options)=>{
      if(!options.providerSessionId)return;
      const session=this.session(sessionId);if(!session)return;
      if(session.nativeHandle&&session.nativeHandle.nativeSessionId!==options.providerSessionId)throw new CatalogError("NATIVE_HANDLE_SCOPE_MISMATCH","Native conversation cannot silently change within a Session");
      this.setNativeHandle(sessionId,{v:1,provider:session.provider,providerInstanceId:session.providerInstanceId,workspaceId:session.workspaceId,nativeSessionId:options.providerSessionId,provenance:"native"});
    });
  }
  dispose():void {this.removeNativeProjection();}
  get db():Database.Database { return this.store.db; }

  workspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id) as RawWorkspace | undefined;
    return row ? {workspaceId:row.id,canonicalRoot:row.canonical_root,worktreeRoot:row.worktree_root,checkoutKey:row.checkout_key,kind:row.kind,state:row.state,repositoryId:row.repository_id,capabilities:JSON.parse(row.capabilities_json) as string[],...(row.registration_operation_id ? {registrationOperationId:row.registration_operation_id}:{}),createdAt:row.created_at,updatedAt:row.updated_at} : undefined;
  }
  workspaces(): WorkspaceRecord[] { return (this.db.prepare("SELECT id FROM workspaces ORDER BY id").all() as Array<{id:string}>).map(({id}) => this.workspace(id)!); }
  putWorkspace(input: Omit<WorkspaceRecord,"createdAt"|"updatedAt">): WorkspaceRecord {
    this.store.assertWriterOwner();
    return this.db.transaction(() => {
      const existing = this.workspace(input.workspaceId);
      if (existing && existing.canonicalRoot !== input.canonicalRoot) throw new CatalogError("WORKSPACE_REGISTRATION_CONFLICT", "A workspace ID cannot silently move to another root");
      const at = new Date().toISOString();
      this.db.prepare(`INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        worktree_root=excluded.worktree_root,checkout_key=excluded.checkout_key,kind=excluded.kind,state=excluded.state,repository_id=excluded.repository_id,
        capabilities_json=excluded.capabilities_json,registration_operation_id=excluded.registration_operation_id,updated_at=excluded.updated_at`)
        .run(input.workspaceId,input.canonicalRoot,input.worktreeRoot,input.checkoutKey,input.kind,input.state,input.repositoryId,JSON.stringify(input.capabilities),input.registrationOperationId ?? null,existing?.createdAt ?? at,at);
      return this.workspace(input.workspaceId)!;
    })();
  }
  provider(id: string): ProviderInstanceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM provider_instances WHERE id=?").get(id) as RawProvider | undefined;
    return row ? {providerInstanceId:row.id,provider:row.provider,executable:row.executable,config:JSON.parse(row.config_json) as ProviderConfiguration,policyVersion:row.policy_version,state:row.state,verification:JSON.parse(row.verification_json) as ProviderVerification,policyCapabilities:JSON.parse(row.policy_capabilities_json) as string[],createdAt:row.created_at,updatedAt:row.updated_at} : undefined;
  }
  providers(): ProviderInstanceRecord[] { return (this.db.prepare("SELECT id FROM provider_instances ORDER BY id").all() as Array<{id:string}>).map(({id}) => this.provider(id)!); }
  putProvider(input: Omit<ProviderInstanceRecord,"createdAt"|"updatedAt">): ProviderInstanceRecord {
    this.store.assertWriterOwner();
    const previous = this.provider(input.providerInstanceId);
    if (previous && previous.provider !== input.provider) throw new CatalogError("PROVIDER_REGISTRATION_CONFLICT");
    const at = new Date().toISOString();
    this.db.prepare(`INSERT INTO provider_instances VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET executable=excluded.executable,config_json=excluded.config_json,
      policy_version=excluded.policy_version,state=excluded.state,verification_json=excluded.verification_json,policy_capabilities_json=excluded.policy_capabilities_json,updated_at=excluded.updated_at`)
      .run(input.providerInstanceId,input.provider,input.executable,JSON.stringify(input.config),input.policyVersion,input.state,JSON.stringify(input.verification),JSON.stringify(input.policyCapabilities),previous?.createdAt ?? at,at);
    return this.provider(input.providerInstanceId)!;
  }
  session(id: string): CatalogSession | undefined {
    const row = this.db.prepare(`SELECT s.*,c.provider_instance_id,c.title,c.native_handle_json,c.residency_state FROM sessions s JOIN session_catalog c ON c.session_id=s.id WHERE s.id=?`).get(id) as RawSession | undefined;
    if (!row) return undefined;
    let handle: SessionNativeHandle | undefined;
    if (row.native_handle_json) {
      const parsed = SessionNativeHandleSchema.safeParse(JSON.parse(row.native_handle_json) as unknown);
      if (!parsed.success || parsed.data.provider !== row.provider || parsed.data.providerInstanceId !== row.provider_instance_id || parsed.data.workspaceId !== row.workspace_id) throw new CatalogError("NATIVE_HANDLE_SCOPE_MISMATCH");
      handle = parsed.data;
    }
    return {sessionId:row.id,workspaceId:row.workspace_id,providerInstanceId:row.provider_instance_id,provider:row.provider,title:row.title,status:row.status,activityState:row.activity_state,headSequence:row.head_sequence,revision:row.revision,residency:row.residency_state,nativeSessionAvailable:Boolean(handle),...(handle ? {nativeHandle:handle}:{}),createdAt:row.created_at,updatedAt:row.updated_at};
  }
  requireSession(id: string): CatalogSession { const session = this.session(id); if (!session) throw new CatalogError("SESSION_NOT_FOUND"); return session; }
  sessions(options: {workspaceId?:string;includeArchived?:boolean;afterSessionId?:string;limit?:number} = {}): CatalogSession[] {
    const ids = this.db.prepare(`SELECT id FROM sessions WHERE (? IS NULL OR workspace_id=?) AND (? OR status='active') AND id>? ORDER BY id LIMIT ?`)
      .all(options.workspaceId ?? null,options.workspaceId ?? null,options.includeArchived ? 1 : 0,options.afterSessionId ?? "",Math.max(1,Math.min(options.limit ?? 100,200))) as Array<{id:string}>;
    return ids.map(({id}) => this.requireSession(id));
  }
  /** Internal admission scans are deliberately uncapped; public lists remain bounded. */
  allSessions(options:{workspaceId?:string;providerInstanceId?:string}={}):CatalogSession[] {
    const ids=this.db.prepare(`SELECT s.id FROM sessions s JOIN session_catalog c ON c.session_id=s.id
      WHERE (? IS NULL OR s.workspace_id=?) AND (? IS NULL OR c.provider_instance_id=?) ORDER BY s.id`)
      .all(options.workspaceId??null,options.workspaceId??null,options.providerInstanceId??null,options.providerInstanceId??null) as Array<{id:string}>;
    return ids.map(({id})=>this.requireSession(id));
  }
  legacyDefaultSessionId(): string | undefined {
    const row = this.db.prepare("SELECT value_json FROM host_state WHERE key='legacyDefaultSessionId'").get() as {value_json:string} | undefined;
    if (!row) return undefined;
    const id = JSON.parse(row.value_json) as unknown;
    if (typeof id !== "string" || !this.session(id)) throw new CatalogError("LEGACY_DEFAULT_INVALID");
    return id;
  }
  setLegacyDefaultOnce(id: string): void {
    this.store.assertWriterOwner(); this.requireSession(id);
    const previous = this.legacyDefaultSessionId();
    if (previous && previous !== id) throw new CatalogError("LEGACY_DEFAULT_CONFLICT");
    this.db.prepare("INSERT OR IGNORE INTO host_state VALUES('legacyDefaultSessionId',?,?)").run(JSON.stringify(id),new Date().toISOString());
  }
  setResidency(id: string, residency: SessionResidency): void {
    this.store.assertWriterOwner(); this.requireSession(id);
    this.db.prepare("UPDATE session_catalog SET residency_state=? WHERE session_id=?").run(residency,id);
  }
  setNativeHandle(id: string, handle: SessionNativeHandle): void {
    this.store.assertWriterOwner(); const session = this.requireSession(id); const parsed = SessionNativeHandleSchema.parse(handle);
    if (parsed.provider !== session.provider || parsed.workspaceId !== session.workspaceId || parsed.providerInstanceId !== session.providerInstanceId) throw new CatalogError("NATIVE_HANDLE_SCOPE_MISMATCH");
    this.db.transaction(() => {
      this.db.prepare("UPDATE session_catalog SET native_handle_json=? WHERE session_id=?").run(JSON.stringify(parsed),id);
      this.db.prepare("UPDATE sessions SET provider_session_id=? WHERE id=?").run(parsed.nativeSessionId,id);
    })();
  }
  assertIdle(id: string): void {
    const session = this.requireSession(id);
    this.assertRecovered(id);
    if (session.activityState !== "idle" || this.store.getActiveTurn(id) || session.residency === "blocked") throw new CatalogError("SESSION_BUSY", "Session has active or unverified execution", true);
    const intents = this.db.prepare("SELECT 1 FROM execution_intents WHERE session_id=? AND state <> 'settled' LIMIT 1").get(id);
    if (intents) throw new CatalogError("RECOVERY_BLOCKED", "Pending execution must be settled first", true);
    if(this.runtimeCloseForSession(id))throw new CatalogError("RECOVERY_BLOCKED","Runtime close is pending or unverified",true);
  }
  assertRecovered(id:string):void {
    const row=this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as {recovery_state?:string}|undefined;
    if(row?.recovery_state==="blocked")throw new CatalogError("RECOVERY_BLOCKED","Session recovery must be settled first",true);
    this.assertRestoreWriteReady();
  }
  private assertRestoreWriteReady():void {
    if(this.options.restoreWriteReady){this.options.restoreWriteReady(this.db);return;}
    if(this.db.prepare("SELECT 1 FROM host_state WHERE key='restore_readiness'").get())throw new CatalogError("RECOVERY_BLOCKED","Restored external state must be reconciled",true);
  }
  private admit(command:CatalogCommand):void {
    this.store.assertWriterOwner();
    this.assertRestoreWriteReady();
    if(!command.commandId||!command.authSubjectId)throw new CatalogError("COMMAND_ID_REQUIRED");
    const device=this.store.getDevice(command.authSubjectId);
    if(device?.revokedAt||(device?.expiresAt&&device.expiresAt<=new Date().toISOString()))throw new CatalogError("DEVICE_REVOKED");
    if(device&&!device.scopes.includes("session:write"))throw new CatalogError("SCOPE_REQUIRED");
  }
  private reused(command: CatalogCommand, method: string, hash: string): CatalogCommit | undefined {
    const receipt = this.store.getCommandReceipt(command.authSubjectId,command.commandId);
    if (!receipt) return undefined;
    if (receipt.method !== method || receipt.requestHash !== hash || receipt.requestFormatVersion !== 2 || !receipt.targetSessionId) throw new CatalogError("COMMAND_ID_REUSED");
    const response = receipt.response as SessionSummaryV2;
    if (!response || response.sessionId !== receipt.targetSessionId) throw new CatalogError("COMMAND_RECEIPT_INVALID");
    return {summary:response,events:[],reused:true};
  }
  create(command: CatalogCommand, input: {workspaceId:string;providerInstanceId:string;title:string}, context: {workspace:WorkspaceRecord;provider:ProviderInstanceRecord}): CatalogCommit {
    this.admit(command);
    if(input.workspaceId!==context.workspace.workspaceId||input.providerInstanceId!==context.provider.providerInstanceId||context.workspace.state!=="active"||context.provider.state!=="configured")throw new CatalogError("RESOURCE_SCOPE_MISMATCH");
    const method = "session.createNew";
    const hash = hashCatalogRequest(method,input,{workspaceId:context.workspace.workspaceId,providerInstanceId:context.provider.providerInstanceId,provider:context.provider.provider});
    return this.db.transaction(() => {
      const previous = this.reused(command,method,hash); if (previous) return previous;
      const id = randomUUID();
      this.store.createSession(context.workspace.canonicalRoot,context.provider.provider,id);
      this.db.prepare("UPDATE sessions SET workspace_id=? WHERE id=?").run(input.workspaceId,id);
      this.db.prepare("INSERT INTO session_catalog VALUES(?,?,?,NULL,'unloaded',NULL)").run(id,input.providerInstanceId,input.title);
      const at=new Date().toISOString();
      const summary = {...publicSessionSummary(this.requireSession(id)),revision:1,headSequence:1,updatedAt:at};
      const committed = this.store.commitCommand({sessionId:id,expectedRevision:0,occurredAt:at,build:() => ({result:summary,
        events:[{type:"session.created",payload:{sessionId:id,...input}}],receipts:[{...command,method,requestHash:hash,requestFormatVersion:2,targetSessionId:id,state:"completed",response:summary}]})})!;
      return {summary:committed.result,events:committed.events,reused:false};
    })();
  }
  change(command: CatalogCommand, method: "session.rename"|"session.archive"|"session.unarchive", input: {sessionId:string;expectedRevision:number;title?:string}): CatalogCommit {
    this.admit(command);
    const resolved = this.requireSession(input.sessionId);
    const hash = hashCatalogRequest(method,input,{sessionId:resolved.sessionId,workspaceId:resolved.workspaceId,providerInstanceId:resolved.providerInstanceId,provider:resolved.provider});
    return this.db.transaction(() => {
      const previous = this.reused(command,method,hash); if (previous) return previous;
      const session = this.requireSession(input.sessionId);
      if (session.revision !== input.expectedRevision) throw new CatalogError("SESSION_REVISION_CONFLICT", "Session changed; reload its revision", true);
      if (method === "session.archive") {
        this.assertIdle(session.sessionId);
        if(session.residency!=="unloaded")throw new CatalogError("SESSION_RUNTIME_LOADED","Close the idle runtime before archiving",true);
      }
      if (method === "session.rename") this.db.prepare("UPDATE session_catalog SET title=? WHERE session_id=?").run(input.title,session.sessionId);
      if (method === "session.archive" || method === "session.unarchive") {
        this.db.prepare("UPDATE sessions SET status=? WHERE id=?").run(method === "session.archive" ? "archived" : "active",session.sessionId);
        this.db.prepare("UPDATE session_catalog SET archived_at=? WHERE session_id=?").run(method === "session.archive" ? new Date().toISOString() : null,session.sessionId);
      }
      const at=new Date().toISOString();
      const summary = {...publicSessionSummary(this.requireSession(session.sessionId)),revision:session.revision+1,headSequence:session.headSequence+1,updatedAt:at};
      const committed = this.store.commitCommand({sessionId:session.sessionId,expectedRevision:input.expectedRevision,occurredAt:at,build:()=>({result:summary,
        events:[{type:`${method}d`,payload:{sessionId:session.sessionId,...(input.title !== undefined ? {title:input.title}:{})}}],
        receipts:[{...command,method,requestHash:hash,requestFormatVersion:2,targetSessionId:session.sessionId,state:"completed",response:summary}]})})!;
      return {summary:committed.result,events:committed.events,reused:false};
    })();
  }

  runtimeClose(id:string):RuntimeCloseOperation|undefined {
    const row=this.db.prepare("SELECT * FROM catalog_runtime_operations WHERE id=?").get(id) as {id:string;session_id:string;auth_subject_id:string;command_id:string;request_hash:string;owner_context_json:string;runtime_id:string|null;state:RuntimeCloseOperation["state"];created_at:string;updated_at:string}|undefined;
    return row?{id:row.id,sessionId:row.session_id,authSubjectId:row.auth_subject_id,commandId:row.command_id,requestHash:row.request_hash,ownerContext:JSON.parse(row.owner_context_json) as RuntimeCloseOwnerContext,...(row.runtime_id?{runtimeId:row.runtime_id}:{}),state:row.state,createdAt:row.created_at,updatedAt:row.updated_at}:undefined;
  }
  runtimeCloseForSession(sessionId:string):RuntimeCloseOperation|undefined {
    const row=this.db.prepare("SELECT id FROM catalog_runtime_operations WHERE session_id=? AND state <> 'completed' LIMIT 1").get(sessionId) as {id:string}|undefined;
    return row?this.runtimeClose(row.id):undefined;
  }
  beginRuntimeClose(command:CatalogCommand,input:{sessionId:string;expectedRevision:number},binding:RuntimeCloseOwnerContext&{runtimeId?:string}):CatalogCloseCommit {
    this.admit(command);
    if(!binding.ownerId||!Number.isSafeInteger(binding.ownerGeneration)||binding.ownerGeneration<1||binding.resourceKeys.some((key)=>typeof key!=="string"))throw new CatalogError("RUNTIME_CLOSE_BINDING_REQUIRED");
    const session=this.requireSession(input.sessionId);
    const method="session.closeRuntime";
    const hash=hashCatalogRequest(method,input,{sessionId:session.sessionId,workspaceId:session.workspaceId,providerInstanceId:session.providerInstanceId,provider:session.provider});
    return this.db.transaction(()=>{
      const previous=this.reused(command,method,hash);
      if(previous) {
        const row=this.db.prepare("SELECT id FROM catalog_runtime_operations WHERE auth_subject_id=? AND command_id=?").get(command.authSubjectId,command.commandId) as {id:string}|undefined;
        if(!row)throw new CatalogError("COMMAND_RECEIPT_INVALID");
        return {...previous,operation:this.runtimeClose(row.id)!};
      }
      this.assertIdle(session.sessionId);
      if(session.revision!==input.expectedRevision)throw new CatalogError("SESSION_REVISION_CONFLICT",undefined,true);
      const id=randomUUID();const at=new Date().toISOString();
      this.db.prepare("INSERT INTO catalog_runtime_operations VALUES(?,?,?,?,?,2,?,?,'accepted',?,?)").run(id,session.sessionId,command.authSubjectId,command.commandId,hash,JSON.stringify({ownerId:binding.ownerId,ownerGeneration:binding.ownerGeneration,resourceKeys:[...binding.resourceKeys]}),binding.runtimeId??null,at,at);
      this.setResidency(session.sessionId,"closing");
      const summary={...publicSessionSummary(this.requireSession(session.sessionId)),revision:session.revision+1,headSequence:session.headSequence+1,updatedAt:at};
      const committed=this.store.commitCommand({sessionId:session.sessionId,expectedRevision:input.expectedRevision,occurredAt:at,build:()=>({result:summary,
        events:[{type:"session.runtime.closing",payload:{sessionId:session.sessionId,operationId:id}}],
        receipts:[{...command,method,requestHash:hash,requestFormatVersion:2,targetSessionId:session.sessionId,state:"accepted",response:summary}]})})!;
      return {summary:committed.result,events:committed.events,reused:false,operation:this.runtimeClose(id)!};
    })();
  }
  settleRuntimeClose(operationId:string,provedStopped:boolean):CatalogCloseCommit {
    this.store.assertWriterOwner();
    return this.db.transaction(()=>{
      const operation=this.runtimeClose(operationId);if(!operation)throw new CatalogError("RUNTIME_OPERATION_NOT_FOUND");
      if(operation.state!=="accepted")return {summary:publicSessionSummary(this.requireSession(operation.sessionId)),events:[],reused:true,operation};
      const session=this.requireSession(operation.sessionId);const at=new Date().toISOString();
      const state=provedStopped?"completed":"outcome_unknown";
      this.db.prepare("UPDATE catalog_runtime_operations SET state=?,updated_at=? WHERE id=? AND state='accepted'").run(state,at,operationId);
      this.setResidency(session.sessionId,provedStopped?"unloaded":"blocked");
      const summary={...publicSessionSummary(this.requireSession(session.sessionId)),revision:session.revision+1,headSequence:session.headSequence+1,updatedAt:at};
      const committed=this.store.commitCommand({sessionId:session.sessionId,expectedRevision:session.revision,occurredAt:at,build:()=>({result:summary,
        events:[{type:provedStopped?"session.runtime.closed":"session.runtime.close_unknown",payload:{sessionId:session.sessionId,operationId}}],
        receiptUpdates:[{authSubjectId:operation.authSubjectId,commandId:operation.commandId,method:"session.closeRuntime",requestHash:operation.requestHash,requestFormatVersion:2,targetSessionId:session.sessionId,state,response:summary,requireExisting:true}]})})!;
      return {summary:committed.result,events:committed.events,reused:false,operation:this.runtimeClose(operationId)!};
    })();
  }
}

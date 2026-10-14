import { randomUUID } from "node:crypto";
import { CreateSessionV2Schema, RenameSessionV2Schema, ChangeSessionStatusV2Schema, ListSessionsV2Schema, type ListSessionsV2Response, type SessionEvent, type SessionSummaryV2 } from "@flyx/mvp-protocol";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { GitService } from "../git/git-service.js";
import { CatalogError, CatalogStore, hashCatalogRequest, publicSessionSummary, type CatalogCommand, type CatalogCommit, type CatalogSession, type ProviderInstanceRecord, type WorkspaceRecord } from "../storage/catalog-store.js";
import type { SqliteStore, TurnRow } from "../storage/db.js";
import { WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { ProviderInstanceRegistry } from "../provider/provider-instance-registry.js";

export type RuntimeCloseReport = {closed:boolean;producerStopped:boolean;clean:boolean;state:"stopped"|"recovery_required";stopped?:boolean;recoveryRequired?:boolean};
export interface SessionRuntime {
  readonly sessionId:string;
  readonly runtimeId?:string;
  closeAndWait(deadlineMs?:number):Promise<RuntimeCloseReport>;
  subscribe?(listener:(event:SessionEvent)=>void):()=>void;
}
export type ResolvedSession = {session:CatalogSession;workspace:WorkspaceRecord;providerInstance:ProviderInstanceRecord};
export type SessionRuntimeContext = ResolvedSession & {store:SqliteStore;owner:HostOwnerHandle;runtimeId:string;ownsStore:false;recoverOnStart:false};
export type SessionRegistryOptions<R extends SessionRuntime> = {
  owner:HostOwnerHandle;
  /** Factory exceptions must finish their own managed-process cleanup. */
  runtimeFactory:(context:SessionRuntimeContext)=>Promise<R>|R;
  publish?:(event:SessionEvent)=>void;
};
type Entry<R> = {runtime?:R;runtimeId?:string;loading?:Promise<R>;closing?:Promise<RuntimeCloseReport>;unsubscribe?:()=>void;cancelLoad:boolean};
const stopped:RuntimeCloseReport={closed:true,producerStopped:true,clean:true,state:"stopped",stopped:true,recoveryRequired:false};

/** Persistent Session routing; history queries never call runtimeFactory. */
export class SessionRegistry<R extends SessionRuntime=SessionRuntime> {
  private readonly entries=new Map<string,Entry<R>>();
  private readonly listeners=new Map<string,Set<(event:SessionEvent)=>void>>();
  private shuttingDown=false;
  constructor(readonly catalog:CatalogStore,readonly workspaces:WorkspaceRegistry,readonly providers:ProviderInstanceRegistry,private readonly options:SessionRegistryOptions<R>) {}
  get store(){return this.catalog.store;}
  resolve(sessionId:string):ResolvedSession {
    const session=this.catalog.requireSession(sessionId);
    const workspace=this.catalog.workspace(session.workspaceId);
    const providerInstance=this.catalog.provider(session.providerInstanceId);
    if(!workspace||!providerInstance||providerInstance.provider!==session.provider)throw new CatalogError("SESSION_BINDING_INVALID");
    return {session,workspace,providerInstance};
  }
  /** Business/FS admission is distinct from the pure persisted read relation. */
  assertExecutionResources(sessionId:string):ResolvedSession {
    this.store.assertWriterOwner();this.options.owner.assertActive();
    if(this.options.owner.mode==="maintenance")throw new CatalogError("HOST_MAINTENANCE_ONLY");
    const resolved=this.resolve(sessionId);
    return {...resolved,workspace:this.workspaces.require(resolved.workspace.workspaceId),providerInstance:this.providers.requireExecution(resolved.providerInstance.providerInstanceId)};
  }
  private executionTarget(sessionId:string):ResolvedSession {
    this.store.assertWriterOwner();
    const resolved=this.resolve(sessionId);
    if(resolved.session.status!=="active")throw new CatalogError("SESSION_ARCHIVED");
    this.catalog.assertRecovered(sessionId);
    if(this.catalog.runtimeCloseForSession(sessionId))throw new CatalogError("RECOVERY_BLOCKED","Runtime close must be settled before loading",true);
    if(this.options.owner.mode==="maintenance")throw new CatalogError("HOST_MAINTENANCE_ONLY");
    const ready=this.assertExecutionResources(sessionId);
    const executionCapabilities=["workspaceWrite","resumeConversation","interrupt","interactiveApprovals","structuredQuestions","checkpointCapture"];
    if(!ready.providerInstance.verification.capabilities.some((capability)=>executionCapabilities.includes(capability)&&ready.providerInstance.policyCapabilities.includes(capability)&&ready.workspace.capabilities.includes(capability)))throw new CatalogError("PROVIDER_CAPABILITY_UNVERIFIED");
    return ready;
  }
  get(sessionId:string):SessionSummaryV2{return publicSessionSummary(this.resolve(sessionId).session);}
  list(input:unknown={}):ListSessionsV2Response {
    const parsed=ListSessionsV2Schema.parse(input);
    if(parsed.workspaceId&&!this.catalog.workspace(parsed.workspaceId))throw new CatalogError("WORKSPACE_NOT_FOUND");
    const options={includeArchived:parsed.includeArchived,limit:parsed.limit,...(parsed.workspaceId?{workspaceId:parsed.workspaceId}:{}),...(parsed.afterSessionId?{afterSessionId:parsed.afterSessionId}:{})};
    const rows=this.catalog.sessions(options);
    const last=rows.at(-1)?.sessionId;
    const hasMore=last&&this.catalog.sessions({...options,afterSessionId:last,limit:1}).length>0;
    return {sessions:rows.map(publicSessionSummary),...(hasMore?{nextSessionId:last}:{})};
  }
  readSnapshot(sessionId:string) {
    const session=this.get(sessionId);
    const snapshot=this.store.getSnapshot(sessionId);if(!snapshot)throw new CatalogError("SESSION_NOT_FOUND");
    const active=snapshot.activeTurn;
    const turn=active?publicTurn(active):undefined;
    return {session,...(turn?{activeTurn:turn}:{}),pendingApprovals:snapshot.pendingApprovals};
  }
  readEvents(sessionId:string,after=0,limit=200,upTo?:number):ReturnType<SqliteStore["listEvents"]> {
    this.resolve(sessionId);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new CatalogError("INVALID_TIMELINE_PAGE");
    return this.store.listEvents(sessionId,after,limit,upTo);
  }
  loaded(sessionId:string):R|undefined{return this.entries.get(sessionId)?.runtime;}
  subscribe(sessionId:string,listener:(event:SessionEvent)=>void):()=>void {
    this.resolve(sessionId);let listeners=this.listeners.get(sessionId);if(!listeners){listeners=new Set();this.listeners.set(sessionId,listeners);}listeners.add(listener);
    return ()=>{listeners.delete(listener);if(!listeners.size)this.listeners.delete(sessionId);};
  }
  /** Call only after the shared Engine commit, never from a transaction hook. */
  publishCommittedEvents(events:readonly SessionEvent[]):void {
    for(const event of events) {
      for(const listener of this.listeners.get(event.sessionId)??[])try{listener(event);}catch{/* Replay repairs delivery. */}
      try{this.options.publish?.(event);}catch{/* Facts are already durable. */}
    }
  }
  requestContext(sessionId:string) {
    const {session}=this.resolve(sessionId);
    return {sessionId:session.sessionId,workspaceId:session.workspaceId,providerInstanceId:session.providerInstanceId,provider:session.provider};
  }
  hashRequest(method:string,parsedPayload:unknown,sessionId:string):string {return hashCatalogRequest(method,parsedPayload,this.requestContext(sessionId));}
  resolveExecutionContext(sessionId:string) {
    const resolved=this.executionTarget(sessionId);
    const turn=this.store.getActiveTurn(sessionId);
    const runtime=this.loaded(sessionId);
    return {...resolved,...(turn?{activeTurn:turn,turnId:turn.id,attemptId:turn.attemptId,generation:turn.generation}:{}),...(runtime?.runtimeId?{runtimeId:runtime.runtimeId}:{}),runtime};
  }

  ensureLoaded(sessionId:string):Promise<R> {
    if(this.shuttingDown)return Promise.reject(new CatalogError("HOST_CLOSING"));
    const barrier=this.entries.get(sessionId)?.closing;
    if(barrier)return barrier.then(()=>this.ensureLoaded(sessionId));
    let resolved:ResolvedSession;
    try {resolved=this.executionTarget(sessionId);}catch(error){return Promise.reject(error);}
    let entry=this.entries.get(sessionId);if(!entry){entry={cancelLoad:false};this.entries.set(sessionId,entry);}
    if(entry.closing)return entry.closing.then(()=>this.ensureLoaded(sessionId));
    if(entry.runtime)return Promise.resolve(entry.runtime);
    if(entry.loading)return entry.loading;
    try {
      this.catalog.assertIdle(sessionId);
      if(resolved.session.residency!=="unloaded")throw new CatalogError("RECOVERY_BLOCKED","An earlier resident runtime must be reconciled before loading",true);
      this.catalog.setResidency(sessionId,"loading");
    }catch(error){return Promise.reject(error);}
    entry.cancelLoad=false;
    const captured=entry;
    const runtimeId=randomUUID();captured.runtimeId=runtimeId;
    const loading=Promise.resolve().then(()=>this.options.runtimeFactory({...resolved,store:this.store,owner:this.options.owner,runtimeId,ownsStore:false,recoverOnStart:false})).then((runtime)=>{
      captured.runtime=runtime;
      if(runtime.sessionId!==sessionId)throw new CatalogError("RUNTIME_SESSION_MISMATCH");
      if(captured.cancelLoad||this.shuttingDown)throw new CatalogError("RUNTIME_CLOSING",undefined,true);
      const current=this.executionTarget(sessionId);
      if(current.session.workspaceId!==resolved.session.workspaceId||current.session.providerInstanceId!==resolved.session.providerInstanceId)throw new CatalogError("SESSION_BINDING_CHANGED");
      this.catalog.setResidency(sessionId,"loaded");
      const unsubscribe=runtime.subscribe?.((event)=>{if(event.sessionId===sessionId)this.publishCommittedEvents([event]);});
      if(unsubscribe)captured.unsubscribe=unsubscribe;
      return runtime;
    }).catch(async(error:unknown)=>{
      if(captured.runtime&&!captured.closing) {
        const report=await this.stop(captured.runtime).catch(()=>({closed:false,producerStopped:false,clean:false,state:"recovery_required" as const}));
        if(report.clean){captured.unsubscribe?.();delete captured.unsubscribe;delete captured.runtime;delete captured.runtimeId;this.catalog.setResidency(sessionId,"unloaded");}
        else this.catalog.setResidency(sessionId,"blocked");
      } else if(!captured.closing) this.catalog.setResidency(sessionId,this.options.owner.retainedReason||this.catalog.requireSession(sessionId).residency==="blocked"?"blocked":"unloaded");
      throw error;
    }).finally(()=>{if(captured.loading===loading)delete captured.loading;});
    captured.loading=loading;
    return loading;
  }

  private stop(runtime:R,deadlineMs?:number):Promise<RuntimeCloseReport> {return runtime.closeAndWait(deadlineMs);}
  /** Lifecycle close. The business command below first journals its accepted effect. */
  closeRuntime(sessionId:string,deadlineMs?:number):Promise<RuntimeCloseReport> {
    const prior=this.resolve(sessionId).session;
    let entry=this.entries.get(sessionId);if(!entry){entry={cancelLoad:false};this.entries.set(sessionId,entry);}
    if(entry.closing)return entry.closing;
    const hadLoading=Boolean(entry.loading);
    entry.cancelLoad=true;
    this.catalog.setResidency(sessionId,"closing");
    const captured=entry;
    const closing=Promise.resolve().then(async()=>{
      if(captured.loading)await captured.loading.catch(()=>undefined);
      const runtime=captured.runtime;
      const report=runtime?await this.stop(runtime,deadlineMs):prior.residency==="unloaded"||hadLoading?stopped:{closed:false,producerStopped:false,clean:false,state:"recovery_required" as const};
      const base=this.store.getSession(sessionId) as {recoveryState?:string}|undefined;
      const clean=report.clean&&report.producerStopped&&!this.store.getActiveTurn(sessionId)&&base?.recoveryState!=="blocked";
      if(clean){captured.unsubscribe?.();delete captured.unsubscribe;delete captured.runtime;delete captured.runtimeId;this.catalog.setResidency(sessionId,"unloaded");return report;}
      this.catalog.setResidency(sessionId,"blocked");
      return {...report,clean:false,state:"recovery_required" as const,recoveryRequired:true};
    }).catch((error:unknown)=>{this.catalog.setResidency(sessionId,"blocked");throw error;}).finally(()=>{if(captured.closing===closing)delete captured.closing;});
    captured.closing=closing;
    return closing;
  }
  async closeRuntimeCommand(command:CatalogCommand,input:unknown,deadlineMs?:number):Promise<CatalogCommit> {
    const parsed=ChangeSessionStatusV2Schema.parse(input);
    this.assertExecutionResources(parsed.sessionId);
    const knownUnloaded=this.catalog.requireSession(parsed.sessionId).residency==="unloaded"&&!this.entries.get(parsed.sessionId)?.runtime&&!this.entries.get(parsed.sessionId)?.loading;
    const runtimeId=this.loaded(parsed.sessionId)?.runtimeId??this.entries.get(parsed.sessionId)?.runtimeId;
    const begun=this.catalog.beginRuntimeClose(command,parsed,{ownerId:this.options.owner.ownerId,ownerGeneration:this.options.owner.generation,resourceKeys:this.options.owner.resourceKeys,...(runtimeId?{runtimeId}:{})});
    this.publish(begun.events);
    if(begun.reused)return {summary:begun.summary,events:begun.events,reused:true};
    let proved=false;
    try {proved=knownUnloaded||(await this.closeRuntime(parsed.sessionId,deadlineMs)).clean;}catch {/* Pending stop remains an explicit durable unknown. */}
    const settled=this.catalog.settleRuntimeClose(begun.operation.id,proved);this.publish(settled.events);return {summary:settled.summary,events:settled.events,reused:settled.reused};
  }
  createNew(command:CatalogCommand,input:unknown):CatalogCommit {
    const parsed=CreateSessionV2Schema.parse(input);
    const result=this.catalog.create(command,parsed,{workspace:this.workspaces.require(parsed.workspaceId),provider:this.providers.requireExecution(parsed.providerInstanceId)});
    this.publish(result.events);return result;
  }
  rename(command:CatalogCommand,input:unknown):CatalogCommit {const parsed=RenameSessionV2Schema.parse(input);this.assertExecutionResources(parsed.sessionId);const result=this.catalog.change(command,"session.rename",parsed);this.publish(result.events);return result;}
  archive(command:CatalogCommand,input:unknown):CatalogCommit {const parsed=ChangeSessionStatusV2Schema.parse(input);this.assertExecutionResources(parsed.sessionId);const result=this.catalog.change(command,"session.archive",parsed);this.publish(result.events);return result;}
  unarchive(command:CatalogCommand,input:unknown):CatalogCommit {const parsed=ChangeSessionStatusV2Schema.parse(input);this.assertExecutionResources(parsed.sessionId);const result=this.catalog.change(command,"session.unarchive",parsed);this.publish(result.events);return result;}
  private publish(events:readonly SessionEvent[]):void {this.publishCommittedEvents(events);}
  async gitStatus(sessionId:string){const resolved=this.resolve(sessionId);const workspace=this.workspaces.require(resolved.workspace.workspaceId);return new GitService(workspace.worktreeRoot).status();}
  async gitDiff(sessionId:string){const resolved=this.resolve(sessionId);const workspace=this.workspaces.require(resolved.workspace.workspaceId);const baseline=this.store.getSessionBaseline(sessionId);const result=await new GitService(workspace.worktreeRoot).diff(baseline?.head);return {...result,...(baseline?.head?{baselineHead:baseline.head}:{}),...(baseline?{baselineDirty:baseline.dirty}:{baselineWarning:"Session baseline has not been captured; historical attribution is unavailable."})};}
  async closeAll(deadlineMs?:number):Promise<RuntimeCloseReport[]> {
    this.shuttingDown=true;
    return Promise.all([...this.entries.keys()].map((id)=>this.closeRuntime(id,deadlineMs).catch(()=>({closed:false,producerStopped:false,clean:false,state:"recovery_required" as const,recoveryRequired:true}))));
  }
}

function publicTurn(turn:TurnRow) {
  const {authSubjectId:_actor,providerSessionId:_nativeSession,attemptId:_attempt,nativeTurnId:_nativeTurn,...publicValue}=turn;
  return publicValue;
}

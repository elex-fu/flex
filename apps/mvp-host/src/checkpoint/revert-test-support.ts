import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandEngine } from "../orchestration/command-engine.js";
import { SqliteStore } from "../storage/db.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { ExecutionStore } from "../storage/execution-store.js";
import { applyRevertSchema } from "../storage/migrations/009-checkpoints.js";
import { ControlledRestore } from "./controlled-restore.js";
import type { ControlledRestoreOptions } from "./controlled-restore.js";
import { CheckpointService } from "./checkpoint-service.js";
import { CheckpointPreviewService } from "./preview-service.js";
import type { CheckpointPreviewContext } from "./preview-service.js";
import { RevertService } from "./revert-service.js";
import type { RevertServiceOptions } from "./revert-service.js";
import { bindingDigest } from "./git-driver.js";
import type { NativeRevertDriver, NativeRevertPreparation, NativeRevertProof, NativeRevertRequest } from "./revert-types.js";
import { checkpointFixture, fixtureGit, temporaryRepository } from "./test-support.js";

export async function stageRaw(root:string,path:string,text:string|Buffer,mode="100644"):Promise<void> {
  const oid=(await fixtureGit(root,["hash-object","-w","--no-filters","--stdin"],Buffer.isBuffer(text)?text:Buffer.from(text))).toString().trim();
  await fixtureGit(root,["update-index","--add","--cacheinfo",`${mode},${oid},${path}`]);
}
export class VerifiedNativeFake implements NativeRevertDriver {
  readonly calls:NativeRevertRequest[]=[];
  readonly states=new Map<string,NativeRevertProof>();
  supported=true;
  applyOverride?: (request:NativeRevertRequest)=>Promise<NativeRevertProof>;
  now=()=>new Date("2026-10-15T01:00:00Z");
  async prepare(input:Parameters<NativeRevertDriver["prepare"]>[0]):Promise<NativeRevertPreparation> {
    if(!this.supported)return {supported:false,reason:"fixture_unverified_version"};
    return {supported:true,capability:{kind:input.mode==="revert"?"conversation-rewind":"new-conversation",evidenceId:"verified-test-native",driverVersion:"fixture-v1",verifiedVersion:"fixture-v1"},
      originalBinding:bindingDigest(input.originalHandle),targetBinding:bindingDigest({checkpointId:input.checkpointId,nativeHandle:input.targetHandle,phase:input.checkpointPhase}),boundary:{checkpointId:input.checkpointId}};
  }
  proof(request:NativeRevertRequest,state:NativeRevertProof["state"]="applied",pendingRequest=false):NativeRevertProof {
    return {state,requestId:request.requestId,originalBinding:request.preparation.originalBinding,targetBinding:request.preparation.targetBinding,
      proofId:randomUUID(),observedAt:this.now().toISOString(),quiescent:!pendingRequest,pendingRequest,
      ...(state==="applied"?{nativeHandle:{sessionId:request.mode==="workspaceRestore"?`new-${request.requestId}`:"native-1",boundary:request.preparation.boundary}}:{})};
  }
  async apply(request:NativeRevertRequest):Promise<NativeRevertProof> {
    this.calls.push(request);if(this.applyOverride)return this.applyOverride(request);
    const proof=this.proof(request);this.states.set(request.requestId,proof);return proof;
  }
  async query(request:NativeRevertRequest):Promise<NativeRevertProof> {
    return {...(this.states.get(request.requestId) ?? this.proof(request,"not_applied")),proofId:randomUUID(),observedAt:this.now().toISOString()};
  }
}
export async function revertFixture(options:{restore?:ControlledRestoreOptions;boundary?:RevertServiceOptions["onBoundary"];setup?:(root:string)=>Promise<void>;afterTarget?:(root:string)=>Promise<void>;persistent?:boolean}={}) {
  const root=await temporaryRepository();if(options.setup)await options.setup(root);
  const f=checkpointFixture(root,options.persistent?join(root,".git","revert-test.sqlite"):":memory:");applyRevertSchema(f.owner.db);
  let time=new Date("2026-10-15T01:00:00Z");let runtimeGeneration=1;let lease=f.context.lease;let actorAllowed=true;let quiescent=true;
  f.service=new CheckpointService({store:f.store,driverFor:()=>f.driver,assertLease:(context)=>{if(bindingDigest(context.lease)!==bindingDigest(lease))throw new Error("WORKSPACE_LEASE_STALE");}});
  f.owner.db.exec("CREATE TABLE test_active_view(session_id TEXT PRIMARY KEY,epoch TEXT,native_json TEXT)");
  f.owner.db.prepare("INSERT INTO test_active_view VALUES(?,?,?)").run(f.context.sessionId,"epoch-1",JSON.stringify({sessionId:"native-1",boundary:"target"}));
  const resolve=():CheckpointPreviewContext=>{
    if(!actorAllowed)throw new Error("SCOPE_REQUIRED");
    const session=f.owner.getSession(f.context.sessionId)!;
    const view=f.owner.db.prepare("SELECT epoch,native_json FROM test_active_view WHERE session_id=?").get(session.id) as {epoch:string;native_json:string};
    return {sessionId:session.id,actorId:"device-1",workspaceId:"default",lease,sessionRevision:session.revision,epoch:view.epoch,runtimeGeneration,nativeHandle:JSON.parse(view.native_json),...(session.activeTurnId?{activeTurnId:session.activeTurnId}:{})};
  };
  await stageRaw(root,"tracked.txt","target-index\n");await writeFile(join(root,"tracked.txt"),"target-workspace\n");
  const target=await f.service.captureCurrent(resolve(),"preview");if(options.afterTarget)await options.afterTarget(root);
  await stageRaw(root,"tracked.txt","current-index\n");await writeFile(join(root,"tracked.txt"),"current-workspace\n");
  f.owner.db.prepare("UPDATE test_active_view SET native_json=?").run(JSON.stringify({sessionId:"native-1",boundary:"current"}));
  const previews=new CheckpointPreviewService({checkpoints:f.service,resolveContext:resolve,now:()=>time,verifyLeaseSuccession:()=>true});
  const page=await previews.createPreview({sessionId:f.context.sessionId,actorId:"device-1",checkpointId:target.checkpointId,expectedSessionRevision:resolve().sessionRevision});
  const native=new VerifiedNativeFake();native.now=()=>time;
  const restore=new ControlledRestore(options.restore);
  const engine=new CommandEngine(f.owner,{clock:{now:()=>time.toISOString(),id:randomUUID}});
  const serviceOptions:RevertServiceOptions={engine,checkpoints:f.service,previews,restore,native,resolveContext:resolve,
    acquire:async()=>({context:resolve()}),dispatchContextFor:(context,operationId,attemptId)=>({hostOwnerId:"owner-1",hostOwnerGeneration:1,sessionId:context.sessionId,flyxTurnId:operationId,runtimeId:"runtime-1",runtimeGeneration:context.runtimeGeneration,attemptId}),
    assertRestoreWriteReady:()=>{},revalidateActorInCommit:()=>{if(!actorAllowed)throw new Error("SCOPE_REQUIRED");},proveQuiescence:async()=>({proven:quiescent,proofId:"stopped-original-writers"}),now:()=>time,
    projectSuccess:(db,input)=>{db.prepare("UPDATE test_active_view SET epoch=?,native_json=? WHERE session_id=?").run(input.epoch,JSON.stringify(input.nativeProof.nativeHandle),input.operation.sessionId);return {epoch:input.epoch,nativeHandleBinding:bindingDigest(input.nativeProof.nativeHandle)};},
    ...(options.boundary?{onBoundary:options.boundary}:{})};
  let revert=new RevertService(serviceOptions);
  const accept=async(mode:"revert"|"workspaceRestore"="revert",commandId:string=randomUUID())=>revert.accept({sessionId:f.context.sessionId,actorId:"device-1",commandId,planId:page.planId,expectedSessionRevision:page.expectedSessionRevision,mode,confirmation:true});
  const dispatch=async(operationId:string)=>{
    const operation=revert.store.require(operationId,f.context.sessionId);const id=operation.commands.at(-1)!.intentId;
    const execution=new ExecutionStore(f.owner);execution.claim(id,{id:"owner-1",generation:1},()=>{});
    const intent=execution.transition({id,expectedStates:["claimed"],state:"dispatching",expectedClaimOwnerId:"owner-1",expectedClaimOwnerGeneration:1},()=>{});
    return revert.handleIntent(intent);
  };
  const inspect=(operationId:string)=>revert.inspectRecovery({sessionId:f.context.sessionId,actorId:"device-1",operationId});
  const resume=async(operationId:string)=>{const evidence=await inspect(operationId);return revert.resumeVerified({sessionId:f.context.sessionId,actorId:"device-1",operationId,commandId:randomUUID(),evidenceId:evidence.evidenceId,expectedSessionRevision:evidence.expectedSessionRevision,confirmation:true});};
  const rollback=async(operationId:string)=>{const evidence=await inspect(operationId);return revert.rollbackToSafety({sessionId:f.context.sessionId,actorId:"device-1",operationId,commandId:randomUUID(),evidenceId:evidence.evidenceId,expectedSessionRevision:evidence.expectedSessionRevision,confirmation:true});};
  const newTurn=()=>f.owner.createTurn({sessionId:f.context.sessionId,turnId:randomUUID(),commandId:randomUUID(),requestHash:"fixture",prompt:"new Turn",generation:1});
  return {...f,get owner(){return f.owner;},get store(){return f.store;},get service(){return f.service;},get engine(){return serviceOptions.engine;},root,target,page,native,restore,resolve,serviceOptions,get revert(){return revert;},accept,dispatch,inspect,resume,rollback,newTurn,
    restart:(patch:Partial<RevertServiceOptions>={})=>{Object.assign(serviceOptions,patch);revert=new RevertService(serviceOptions);return revert;},
    reopen:()=>{
      if(!options.persistent)throw new Error("PERSISTENT_FIXTURE_REQUIRED");if(f.owner.db.open)f.owner.close();f.owner=new SqliteStore(join(root,".git","revert-test.sqlite"));f.store=new CheckpointStore(f.owner.db);
      f.service=new CheckpointService({store:f.store,driverFor:()=>f.driver,assertLease:(context)=>{if(bindingDigest(context.lease)!==bindingDigest(lease))throw new Error("WORKSPACE_LEASE_STALE");}});
      serviceOptions.engine=new CommandEngine(f.owner,{clock:{now:()=>time.toISOString(),id:randomUUID}});serviceOptions.checkpoints=f.service;
      serviceOptions.previews=new CheckpointPreviewService({checkpoints:f.service,resolveContext:resolve,now:()=>time,verifyLeaseSuccession:()=>true});revert=new RevertService(serviceOptions);return revert;
    },
    advance:(ms:number)=>{time=new Date(time.getTime()+ms);},setLease:(value:typeof lease)=>{lease=value;},setRuntime:(value:number)=>{runtimeGeneration=value;},setActorAllowed:(value:boolean)=>{actorAllowed=value;},setQuiescent:(value:boolean)=>{quiescent=value;}};
}

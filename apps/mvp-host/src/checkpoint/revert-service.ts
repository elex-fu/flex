import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CheckpointRevertEvidence, CheckpointRevertOperation, SessionEvent } from "@flyx/mvp-protocol";
import { CommandEngine, hashCommandRequest } from "../orchestration/command-engine.js";
import { assertReceiptRequest } from "../orchestration/command-contract.js";
import type { CommandPlan, CommandReceiptInput, CommandRequest, ExecutionIntentInput, ExecutionIntentRow } from "../orchestration/command-contract.js";
import { ExecutionStore } from "../storage/execution-store.js";
import type { DispatchContext } from "../provider/types.js";
import { bindingDigest, digest, validateCheckpointPath } from "./git-driver.js";
import { CheckpointService } from "./checkpoint-service.js";
import { CheckpointPreviewService } from "./preview-service.js";
import type { CheckpointPreviewContext, LeaseSuccession } from "./preview-service.js";
import { ControlledRestore, sameFileContent } from "./controlled-restore.js";
import { RevertStore, publicRevertOperation } from "./revert-store.js";
import { CHECKPOINT_POLICY_VERSION, CheckpointError } from "./types.js";
import type { CheckpointManifest, CheckpointPreviewPlan } from "./types.js";
import { RevertCrash } from "./revert-types.js";
import type { NativeRevertMutation, NativeRevertMutationJournal, NativeRevertMutationReceipt } from "./native-revert-drivers.js";
import type { FileState, NativeRevertDriver, NativeRevertPreparation, NativeRevertProof, NativeRevertRequest, RestoreInspection, RestoreTarget, RevertAcceptInput, RevertAcquisition, RevertCommand, RevertOperation, RevertRecoveryEvidence, RevertStep } from "./revert-types.js";

export const REVERT_INTENT_KIND = "checkpoint_revert";
export type RevertOperationResult = { status:"settled"|"outcome_unknown";resultCode:string;result:CheckpointRevertOperation };
export type RevertServiceOptions = {
  engine: CommandEngine; checkpoints: CheckpointService; previews: CheckpointPreviewService; restore: ControlledRestore;
  /** Authorizes actor, acquires the actual lease, and returns current authoritative facts. */
  acquire: (input:{sessionId:string;actorId:string;workspaceId:string;previousLease:CheckpointPreviewPlan["lease"]}) => Promise<RevertAcquisition>;
  resolveContext: (sessionId:string,actorId:string)=>CheckpointPreviewContext|Promise<CheckpointPreviewContext>;
  dispatchContextFor: (context:CheckpointPreviewContext,operationId:string,attemptId:string)=>DispatchContext;
  verifyLeaseSuccession?: (proof:LeaseSuccession)=>boolean|Promise<boolean>;
  native?: NativeRevertDriver;
  /** Binds concrete managed drivers to this Service's Engine-owned durable journal. */
  nativeFactory?: (journal: NativeRevertMutationJournal) => NativeRevertDriver;
  /** Must prove original helper/owner workspace writers stopped. A missing handle is not proof. */
  proveQuiescence: (operation:RevertOperation)=>Promise<{proven:boolean;proofId:string}>;
  /** Synchronous actual R09/native projection, using this same DB. Throwing or returning a Promise rolls back success. */
  projectSuccess: (db:Database.Database,input:{operation:RevertOperation;epoch:string;nativeProof:NativeRevertProof;sourceSequence:number})=>{epoch:string;nativeHandleBinding:string};
  /** Trusted marker-transaction evidence when custom Worker hooks add revisions. Default allows the two standard Worker commits only. */
  revalidateActorInCommit: (operation:RevertOperation)=>void;
  /** R15 restore readiness is a separate write gate; never clear it from generic recovery. */
  assertRestoreWriteReady: (db:Database.Database)=>void;
  verifyWorkerRevision?: (intent:ExecutionIntentRow,operation:RevertOperation,currentRevision:number)=>boolean;
  publishCommitted?: (events:readonly SessionEvent[])=>void;
  nativeTimeoutMs?: number; evidenceTtlMs?: number; now?:()=>Date;
  onBoundary?: (boundary:string,operation:RevertOperation,step?:RevertStep)=>void|Promise<void>;
};
type RecoveryInput={sessionId:string;actorId:string;operationId:string;commandId:string;evidenceId:string;expectedSessionRevision:number;confirmation:true};

/** SQL transactions surround facts, never external Git, filesystem or native waits. */
export class RevertService {
  readonly store: RevertStore;
  readonly nativeMutationJournal: NativeRevertMutationJournal;
  private readonly native: NativeRevertDriver | undefined;
  private sealed=false;
  private readonly running=new Map<string,Promise<RevertOperationResult>>();
  private readonly producers=new Set<Promise<unknown>>();
  constructor(private readonly options:RevertServiceOptions) {
    if (options.engine.store.db !== options.checkpoints.store.db) throw new Error("REVERT_SHARED_STORE_REQUIRED");
    this.store=new RevertStore(options.engine.store.db);
    this.nativeMutationJournal={claim:(mutation)=>this.claimNativeMutation(mutation),get:(operationId,requestId)=>this.getNativeMutation(operationId,requestId),record:(mutation,receipt)=>this.recordNativeMutation(mutation,receipt)};
    if(options.native && options.nativeFactory)throw new Error("NATIVE_DRIVER_CONFIGURATION_CONFLICT");
    this.native=options.nativeFactory?.(this.nativeMutationJournal) ?? options.native;
  }
  seal():void {this.sealed=true;this.store.seal();this.options.restore.seal();}
  private assertOpen():void {if(this.sealed)throw new CheckpointError("REVERT_SEALED","Revert execution is sealed");}
  async accept(input:RevertAcceptInput):Promise<CheckpointRevertOperation> {
    this.assertOpen();if (input.confirmation !== true) throw new CheckpointError("REVERT_CONFIRMATION_REQUIRED","Explicit execution confirmation is required");
    const plan=this.options.checkpoints.store.getPreview(input.planId,input.sessionId,input.actorId);
    const request=this.request(input.mode === "revert" ? "checkpoint.executeRevert":"checkpoint.workspaceRestore",input,plan.workspaceId);
    const authorized=await this.resolve(input.sessionId,input.actorId);
    const reused=this.reuse(request); if (reused) return reused;
    if (authorized.sessionRevision !== input.expectedSessionRevision || plan.expectedSessionRevision !== input.expectedSessionRevision) throw new CheckpointError("PLAN_STALE","Session changed after preview");
    const acquired=await this.options.acquire({sessionId:input.sessionId,actorId:input.actorId,workspaceId:plan.workspaceId,previousLease:plan.lease});
    const validated=await this.options.previews.validatePlan({sessionId:input.sessionId,actorId:input.actorId,planId:input.planId,...(acquired.succession?{leaseSuccession:acquired.succession}:{})});
    if (this.contextBinding(acquired.context)!==this.contextBinding(validated.context)) throw new CheckpointError("PLAN_STALE","Lease acquisition returned different authoritative facts");
    const context=validated.context;
    await this.options.restore.probe();
    if (!validated.current.gitDirectory) throw new CheckpointError("CAPTURE_UNAVAILABLE","Current checkpoint has no registered Git directory");
    const capabilities=await this.options.restore.identify(this.options.checkpoints.driver(plan.workspaceId).workspace,validated.current.gitDirectory);
    await this.options.restore.verifyRepository(this.options.checkpoints.driver(plan.workspaceId).workspace,capabilities);
    const preparation=await this.prepareNative(input.mode,plan,validated.target);
    if (input.mode === "revert" && !preparation.supported) throw new CheckpointError("PROVIDER_REWIND_UNSUPPORTED","Provider has no verified conversation rewind capability; use workspaceRestore");
    const operationId=randomUUID(),attemptId=randomUUID(),intentId=randomUUID(),createdAt=this.now();
    const command=this.command(context,operationId,attemptId,intentId,input.commandId,request.requestHash,"execute");
    const operation:RevertOperation={operationId,sessionId:input.sessionId,actorId:input.actorId,workspaceId:plan.workspaceId,plan,mode:input.mode,
      stage:"validated",lastCompletedStage:"validated",status:"queued",revision:0,sessionRevision:context.sessionRevision+1,gateRecoveryRevision:0,
      lease:context.lease,capabilities,targetCheckpointId:plan.checkpointId,currentCheckpointId:plan.currentCheckpointId,nativePreparation:preparation,
      commands:[command],steps:[],createdAt,updatedAt:createdAt};
    operation.steps=await this.buildSteps(operation,validated.target);
    const before=await this.options.checkpoints.driver(plan.workspaceId).fingerprint(validated.current.entries.map((entry)=>entry.path));
    if (before.workspaceDigest!==plan.expectedWorkspaceDigest || before.indexDigest!==plan.expectedIndexDigest || before.head!==validated.current.head || before.branch!==validated.current.branch) throw new CheckpointError("PLAN_STALE","Workspace changed before acceptance");
    this.checkExpiry(operation); this.sameContext(context,await this.resolve(input.sessionId,input.actorId));
    const eventId=randomUUID();
    return this.project(eventId,()=>this.options.engine.commitRequest(request,()=>({result:publicRevertOperation(operation),
      events:[{id:eventId,type:"checkpoint.revert.accepted",payload:{operationId,planId:plan.planId,mode:input.mode},options:{activityState:"outcome_unknown"}}],
      receipts:[this.receipt(request,publicRevertOperation(operation))],intents:[this.intent(operation,command)]}),{expectedRevision:context.sessionRevision}).result,
    ()=>{
      if (!this.options.checkpoints.store.transitionPreview(plan.planId,"active","consumed")) throw new CheckpointError("PLAN_STALE","Preview was consumed by another command");
      this.assertActor(operation);this.store.blockGate(operation); this.store.insert(operation);
      this.options.checkpoints.store.pin(plan.checkpointId,"revert",operationId);this.options.checkpoints.store.pin(plan.currentCheckpointId,"revert",operationId);
    });
  }
  /** Register this handler with R06 before worker.start(). Startup recovery never invokes it automatically. */
  handleIntent(intent:ExecutionIntentRow):Promise<RevertOperationResult> {
    this.assertOpen();if (this.running.has(intent.resourceId)) return Promise.reject(new CheckpointError("WORKSPACE_BUSY","Revert handler is already running"));
    const work=this.run(intent);this.running.set(intent.resourceId,work);
    void work.finally(()=>this.running.delete(intent.resourceId)).catch(()=>{});return work;
  }
  getOperation(input:{sessionId:string;actorId:string;operationId:string}):CheckpointRevertOperation {
    return publicRevertOperation(this.store.require(input.operationId,input.sessionId,input.actorId));
  }
  async drain(deadlineMs=5000):Promise<boolean> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    const complete=async()=>{while(this.running.size || this.producers.size)await Promise.allSettled([...this.running.values(),...this.producers]);return true;};
    try{return await Promise.race([complete(),new Promise<boolean>((resolve)=>{timer=setTimeout(()=>resolve(false),Math.max(0,deadlineMs));})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  async inspectRecovery(input:{sessionId:string;actorId:string;operationId:string}):Promise<CheckpointRevertEvidence> {
    const operation=this.store.require(input.operationId,input.sessionId,input.actorId);
    if (operation.status === "completed" || operation.status === "rolled_back" || this.running.has(operation.operationId)) throw new CheckpointError("RECOVERY_BLOCKED","Operation is terminal or still running");
    this.store.assertGate(operation);
    const acquisition=await this.acquire(operation); const context=acquisition.context;
    this.checkContext(operation,context,false); await this.verifyRefs(operation);
    const quiescence=await this.options.proveQuiescence(operation);
    if (!quiescence.proven || !quiescence.proofId) throw new CheckpointError("RECOVERY_BLOCKED","Original workspace writers have not been proven stopped");
    const inspection=await this.inspect(operation);
    const driver=this.options.checkpoints.driver(operation.workspaceId);
    const fingerprint=await driver.fingerprint(this.capturePaths(operation));
    const provider=operation.steps.find((step)=>step.kind === "provider");
    const nativeProof=provider?.request && provider.attempts.length ? await this.queryNative(provider.request):undefined;
    if (nativeProof && provider?.request) this.checkNativeProof(nativeProof,provider.request,false);
    const authoritative=await this.resolve(operation.sessionId,operation.actorId);this.sameContext(context,authoritative);
    const observedAt=this.now();
    const evidence:RevertRecoveryEvidence={evidenceId:randomUUID(),operationId:operation.operationId,sessionId:operation.sessionId,actorId:operation.actorId,
      operationRevision:operation.revision,sessionRevision:context.sessionRevision,recoveryRevision:operation.gateRecoveryRevision,contextBinding:this.contextBinding(context),
      lease:context.lease,inspection,...(fingerprint.head?{head:fingerprint.head}:{}),...(fingerprint.branch?{branch:fingerprint.branch}:{}),workspaceDigest:fingerprint.workspaceDigest,
      ...(nativeProof?{nativeProof}:{}),quiescenceProofId:quiescence.proofId,observedAt,expiresAt:new Date(this.date().getTime()+Math.max(1000,Math.min(120_000,this.options.evidenceTtlMs ?? 30_000))).toISOString()};
    this.store.db.transaction(()=>{
      if(this.store.require(operation.operationId,operation.sessionId).revision!==operation.revision || this.options.engine.store.getSession(operation.sessionId)?.revision!==context.sessionRevision) throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Operation changed during inspection");
      this.store.assertGate(operation);this.store.putEvidence(evidence);
    })();
    const reason=this.resumeBlock(operation,evidence);
    return {evidenceId:evidence.evidenceId,operationId:operation.operationId,sessionId:operation.sessionId,expectedSessionRevision:evidence.sessionRevision,
      operationRevision:evidence.operationRevision,expiresAt:evidence.expiresAt,resumable:!reason,safetyRollbackAvailable:Boolean(operation.safetyCheckpointId),...(reason?{reason}: {})};
  }
  async resumeVerified(input:RecoveryInput):Promise<CheckpointRevertOperation> {
    if(input.confirmation!==true) throw new CheckpointError("REVERT_CONFIRMATION_REQUIRED","Explicit recovery confirmation is required");
    const original=this.store.require(input.operationId,input.sessionId,input.actorId);
    const request=this.request("checkpoint.resumeVerified",input,original.workspaceId);await this.resolve(input.sessionId,input.actorId);
    const reused=this.reuse(request);if(reused)return reused;
    const {evidence,context}=await this.validateEvidence(original,input);
    const reason=this.resumeBlock(original,evidence);if(reason)throw new CheckpointError("RECOVERY_BLOCKED",reason);
    const operation=structuredClone(original);operation.lease=context.lease;operation.recoveryExpiresAt=evidence.expiresAt;
    const command=this.command(context,operation.operationId,randomUUID(),randomUUID(),input.commandId,request.requestHash,"resume");operation.commands.push(command);
    operation.status="queued";operation.stage=operation.lastCompletedStage;delete operation.errorCode;
    const target=this.options.checkpoints.store.require(operation.targetCheckpointId,operation.sessionId);
    if (!operation.nativePreparation.supported) operation.nativePreparation=await this.prepareNative(operation.mode,operation.plan,target);
    for(const step of operation.steps) {
      if(step.state!=="dispatching" && step.state!=="outcome_unknown") continue;
      if(step.kind==="owned_cleanup") {
        const originalStep=step.cleanup!.originalStep;
        if(!this.hasArtifacts(evidence.inspection.artifacts[originalStep.stepId])){step.state="applied";step.result={cleanedStepId:originalStep.stepId,evidenceId:evidence.evidenceId};}
        else {step.state="pending";step.expected=originalStep.kind==="index"?evidence.inspection.indexState:evidence.inspection.files[originalStep.path!]!;step.artifact=evidence.inspection.artifacts[originalStep.stepId]!;}
      } else if(step.kind==="provider") {
        const proof=evidence.nativeProof!;
        if(proof.state==="applied") {step.state="applied";step.result=proof;operation.nativeProof=proof;}
        else {step.state="pending";if(step.request)step.request={...step.request,requestId:randomUUID()};}
      } else if(step.kind==="safety_capture") {
        const safety=this.findSafety(operation);
        if(safety) {this.attachSafety(operation,safety);step.state="applied";step.result={checkpointId:safety.checkpointId};}
        else step.state="pending";
      } else {
        const actual=step.kind==="index"?evidence.inspection.indexState:evidence.inspection.files[step.path!]!;
        const applied=step.kind==="index"?evidence.inspection.indexDigest===step.desiredIndexDigest:sameFileContent(actual,step.target!);
        const artifact=evidence.inspection.artifacts[step.stepId]!;
        if(applied && !this.hasArtifacts(artifact)) {step.state="applied";step.result=step.kind==="index"?{indexDigest:evidence.inspection.indexDigest,indexState:actual}:{file:actual};}
        else {step.state="pending";step.expected=actual;step.artifact=artifact!;if(step.kind==="index")step.expectedIndexDigest=evidence.inspection.indexDigest;}
      }
    }
    // A fresh explicit command binds every remaining file collision/read stamp and index digest.
    for(const step of operation.steps.filter((item)=>item.state==="pending" && ["workspace_file","mkdir","index"].includes(item.kind))) {
      const actual=step.kind==="index"?evidence.inspection.indexState:evidence.inspection.files[step.path!]!;
      step.expected=actual;step.artifact=evidence.inspection.artifacts[step.stepId]!;if(step.kind==="index")step.expectedIndexDigest=evidence.inspection.indexDigest;
    }
    const eventId=randomUUID();operation.revision++;operation.sessionRevision=context.sessionRevision+1;operation.updatedAt=this.now();
    return this.project(eventId,()=>this.options.engine.commitRequest(request,()=>({result:publicRevertOperation(operation),
      events:[{id:eventId,type:"checkpoint.revert.resume.accepted",payload:{operationId:operation.operationId,evidenceId:evidence.evidenceId},options:{activityState:"outcome_unknown"}}],
      receipts:[this.receipt(request,publicRevertOperation(operation))],intents:[this.intent(operation,command)]}),{expectedRevision:context.sessionRevision}).result,
      ()=>{this.assertActor(operation);this.store.assertGate(original);this.store.consumeEvidence(evidence,input.commandId);this.store.save(operation,original.revision);});
  }
  async rollbackToSafety(input:RecoveryInput):Promise<CheckpointRevertOperation> {
    const source=this.store.require(input.operationId,input.sessionId,input.actorId);
    if(input.confirmation!==true || !source.safetyCheckpointId) throw new CheckpointError("SAFETY_CHECKPOINT_UNAVAILABLE","Safety rollback requires a retained safety checkpoint and explicit confirmation");
    const request=this.request("checkpoint.rollbackToSafety",input,source.workspaceId);await this.resolve(input.sessionId,input.actorId);
    const reused=this.reuse(request);if(reused)return reused;
    const {evidence,context}=await this.validateEvidence(source,input);
    const target=this.options.checkpoints.store.require(source.safetyCheckpointId,source.sessionId);
    const operationId=randomUUID(),createdAt=this.now();
    const command=this.command(context,operationId,randomUUID(),randomUUID(),input.commandId,request.requestHash,"rollback");
    let preparation:NativeRevertPreparation={supported:false,reason:"original_provider_state_unknown"};
    if(!source.steps.find((step)=>step.kind==="provider")?.attempts.length || evidence.nativeProof && evidence.nativeProof.state!=="unknown" && evidence.nativeProof.quiescent && !evidence.nativeProof.pendingRequest) {
      preparation=await this.prepareNative("workspaceRestore",source.plan,target);
    }
    const operation:RevertOperation={operationId,sessionId:source.sessionId,actorId:source.actorId,workspaceId:source.workspaceId,plan:source.plan,mode:"workspaceRestore",
      stage:"validated",lastCompletedStage:"validated",status:"queued",revision:0,sessionRevision:context.sessionRevision+1,gateRecoveryRevision:0,
      lease:context.lease,capabilities:source.capabilities,targetCheckpointId:target.checkpointId,currentCheckpointId:source.currentCheckpointId,
      nativePreparation:preparation,commands:[command],steps:[],createdAt,updatedAt:createdAt,parentOperationId:source.operationId,recoveryExpiresAt:evidence.expiresAt};
    // Only the original planned workspace paths: never a new whole-tree delete catalog.
    const originalPaths=new Set(source.steps.filter((step)=>step.kind==="workspace_file").map((step)=>step.path!));
    operation.steps=await this.buildSteps(operation,target,originalPaths,evidence.inspection);
    const cleanups:RevertStep[]=source.steps.filter((step)=>this.hasArtifacts(evidence.inspection.artifacts[step.stepId]) && (step.kind==="workspace_file" || step.kind==="index"))
      .map((step)=>({stepId:randomUUID(),ordinal:0,kind:"owned_cleanup",state:"pending",attempts:[],cleanup:{originalStep:structuredClone(step),parentOperationId:source.operationId},
        expected:step.kind==="index"?evidence.inspection.indexState:evidence.inspection.files[step.path!]!,artifact:evidence.inspection.artifacts[step.stepId]!}));
    operation.steps.splice(1,0,...cleanups);operation.steps.forEach((step,index)=>step.ordinal=index);
    const eventId=randomUUID();
    return this.project(eventId,()=>this.options.engine.commitRequest(request,()=>({result:publicRevertOperation(operation),
      events:[{id:eventId,type:"checkpoint.revert.rollback.accepted",payload:{operationId,parentOperationId:source.operationId,evidenceId:evidence.evidenceId},options:{activityState:"outcome_unknown"}}],
      receipts:[this.receipt(request,publicRevertOperation(operation))],intents:[this.intent(operation,command)]}),{expectedRevision:context.sessionRevision}).result,
      ()=>{this.assertActor(operation);this.store.consumeEvidence(evidence,input.commandId);this.store.blockGate(operation,source.operationId);this.store.insert(operation);
        this.options.checkpoints.store.pin(target.checkpointId,"revert",operationId);});
  }
  private async run(intent:ExecutionIntentRow):Promise<RevertOperationResult> {
    let operation=this.store.require(intent.resourceId,intent.sessionId,intent.authSubjectId);
    if(operation.status==="completed" || operation.status==="rolled_back")return {status:"settled",resultCode:"REVERT_COMPLETED",result:publicRevertOperation(operation)};
    try {
      const current=new ExecutionStore(this.options.engine.store).get(intent.id);const command=operation.commands.at(-1)!;
      if(!current || current.kind!==REVERT_INTENT_KIND || current.state!=="dispatching" || current.id!==command.intentId || current.requestHash!==command.requestHash ||
        current.commandId!==command.commandId || current.attemptId!==command.attemptId || bindingDigest(current.dispatchContext)!==bindingDigest(command.dispatchContext) ||
        current.claimOwnerId!==command.dispatchContext.hostOwnerId || current.claimOwnerGeneration!==command.dispatchContext.hostOwnerGeneration) throw new CheckpointError("REVERT_INTENT_FENCE_MISMATCH","Intent does not match its immutable accepted owner binding");
      if(operation.steps.some((step)=>step.state==="dispatching" || step.state==="outcome_unknown") || operation.status!=="queued") throw new CheckpointError("RECOVERY_REQUIRED","Unknown action is never automatically replayed");
      this.store.assertGate(operation);
      const acquisition=await this.acquire(operation);const context=acquisition.context;this.checkContext(operation,context,true);
      const allowed=this.options.verifyWorkerRevision?.(current,operation,context.sessionRevision) ?? context.sessionRevision===command.acceptedRevision+2;
      if(!allowed)throw new CheckpointError("PLAN_STALE","Session changed outside this command's claim and dispatch marker");
      this.checkExpiry(operation);await this.verifyRefs(operation);
      if(command.kind==="execute") {
        const source=this.options.checkpoints.store.require(operation.currentCheckpointId,operation.sessionId);
        const fingerprint=await this.options.checkpoints.driver(operation.workspaceId).fingerprint(source.entries.map((entry)=>entry.path));
        if(fingerprint.workspaceDigest!==operation.plan.expectedWorkspaceDigest || fingerprint.indexDigest!==operation.plan.expectedIndexDigest || fingerprint.head!==source.head || fingerprint.branch!==source.branch) throw new CheckpointError("PLAN_STALE","Workspace changed after execution acceptance");
      }
      operation=this.update(operation,"checkpoint.revert.worker.started",context.sessionRevision,(next)=>{next.status="running";next.lease=context.lease;});
      await this.boundary("validated",operation);
      for(const candidate of operation.steps) {
        const step=operation.steps.find((item)=>item.stepId===candidate.stepId)!;if(step.state==="applied")continue;
        await this.options.checkpoints.assertLease(await this.authoritative(operation));this.checkExpiry(operation);
        if(step.kind==="safety_capture")operation=await this.safety(operation,step);
        else if(step.kind==="provider")operation=await this.provider(operation,step);
        else if(step.kind==="owned_cleanup")operation=await this.cleanup(operation,step);
        else operation=await this.file(operation,step);
      }
      if(!operation.workspaceProof)operation=await this.commitWorkspaceStage(operation);
      if(!operation.nativeProof)throw new CheckpointError("NEW_CONVERSATION_REQUIRED","Workspace restore needs a new conversation or verified native recovery before a new Turn");
      return await this.finish(operation);
    } catch(error) {
      if(this.sealed)return {status:"outcome_unknown",resultCode:"REVERT_SEALED",result:publicRevertOperation(operation)};
      if(error instanceof RevertCrash)throw error;
      const rawCode=error instanceof CheckpointError?error.code:error instanceof Error && error.message==="SESSION_REVISION_CONFLICT"?"PLAN_STALE":error instanceof Error?error.message:"";
      const code=/^[A-Z][A-Z0-9_]{0,127}$/.test(rawCode)?rawCode:"REVERT_PARTIAL_FAILURE";
      operation=this.store.require(operation.operationId,operation.sessionId);
      try {operation=this.partial(operation,code);} catch { /* Existing marker and gate remain durable if storage/owner is unavailable. */ }
      return {status:"outcome_unknown",resultCode:code,result:publicRevertOperation(operation)};
    }
  }
  private async safety(operation:RevertOperation,step:RevertStep):Promise<RevertOperation> {
    operation=this.dispatch(operation,step.stepId);await this.boundary("safety_capture.dispatch",operation,this.step(operation,step.stepId));
    const context=await this.authoritative(operation);
    const safety=await this.options.checkpoints.captureCurrent({...context,turnId:operation.operationId,attemptId:operation.commands[0]!.attemptId},"safety",this.capturePaths(operation));
    if(safety.status!=="complete" || safety.samplingConsistency!=="stable")throw new CheckpointError("SAFETY_CHECKPOINT_UNAVAILABLE","Safety capture is not exact");
    await this.boundary("safety_capture.external",operation,step);
    operation=this.applied(operation,step.stepId,{checkpointId:safety.checkpointId},(next)=>{this.attachSafety(next,safety);next.stage="safety_captured";next.lastCompletedStage="safety_captured";});
    await this.boundary("safety_captured",operation);
    if(operation.commands.at(-1)!.kind==="execute") {
      const original=this.options.checkpoints.store.require(operation.currentCheckpointId,operation.sessionId);
      if(safety.workspaceDigest!==operation.plan.expectedWorkspaceDigest || safety.indexDigest!==operation.plan.expectedIndexDigest || safety.head!==original.head || safety.branch!==original.branch)throw new CheckpointError("PLAN_STALE","Workspace changed during safety capture");
    }
    return operation;
  }
  private async cleanup(operation:RevertOperation,step:RevertStep):Promise<RevertOperation> {
    const original=step.cleanup!.originalStep;const inspection=await this.inspect(operation);
    const actual=original.kind==="index"?inspection.indexState:inspection.files[original.path!]!;
    if(!sameFileContent(actual,step.expected!))throw new CheckpointError("FILE_COLLISION","Cleanup destination changed");
    let data:Buffer=Buffer.alloc(0);
    if(original.kind==="index")data=(await this.options.restore.prepareIndex(this.options.checkpoints.driver(operation.workspaceId),this.options.checkpoints.store.require(step.cleanup!.parentOperationId===operation.parentOperationId ? this.store.require(step.cleanup!.parentOperationId,operation.sessionId).targetCheckpointId:operation.targetCheckpointId,operation.sessionId),operation.capabilities)).data;
    else data=await this.options.restore.targetBytes(this.options.checkpoints.driver(operation.workspaceId),original.target!);
    operation=this.dispatch(operation,step.stepId,(next)=>{next.expected=actual;next.artifact=inspection.artifacts[original.stepId]!;});
    await this.boundary("owned_cleanup.dispatch",operation,step);
    const result=await this.options.restore.cleanup(operation.operationId,operation.capabilities,this.step(operation,step.stepId),data);
    await this.boundary("owned_cleanup.external",operation,step);operation=this.applied(operation,step.stepId,result);return operation;
  }
  private async file(operation:RevertOperation,step:RevertStep):Promise<RevertOperation> {
    if(!operation.safetyCheckpointId)throw new CheckpointError("SAFETY_CHECKPOINT_UNAVAILABLE","File action has no pinned safety capture");
    await this.options.restore.verifyRepository(this.options.checkpoints.driver(operation.workspaceId).workspace,operation.capabilities);
    const observed=await this.inspect(operation);const actual=step.kind==="index" ? observed.indexState:observed.files[step.path!]!;
    // Created parent directories change no file bytes; get new exact stamps only when semantic precondition still holds.
    if(!sameFileContent(actual,step.expected!))throw new CheckpointError("FILE_COLLISION","A planned destination changed before dispatch");
    let data:Buffer=Buffer.alloc(0);let desiredIndexDigest:string|undefined;
    if(step.kind==="index") {
      const prepared=await this.options.restore.prepareIndex(this.options.checkpoints.driver(operation.workspaceId),this.options.checkpoints.store.require(operation.targetCheckpointId,operation.sessionId),operation.capabilities);
      data=prepared.data;desiredIndexDigest=prepared.digest;
      if(step.desiredIndexDigest && step.desiredIndexDigest!==desiredIndexDigest)throw new CheckpointError("TARGET_OBJECT_CORRUPT","Prepared index changed during recovery");
      if(observed.indexDigest!==step.expectedIndexDigest)throw new CheckpointError("INDEX_COLLISION","Staged index changed before dispatch");
    } else if(step.target)data=await this.options.restore.targetBytes(this.options.checkpoints.driver(operation.workspaceId),step.target);
    operation=this.dispatch(operation,step.stepId,(next)=>{next.expected=actual;next.artifact=observed.artifacts[step.stepId]!;if(desiredIndexDigest)next.desiredIndexDigest=desiredIndexDigest;});
    const marked=this.step(operation,step.stepId);await this.boundary(`${step.kind}.dispatch`,operation,marked);
    const result=await this.options.restore.apply(operation.operationId,operation.capabilities,marked,data);
    await this.boundary(`${step.kind}.external`,operation,marked);
    operation=this.applied(operation,step.stepId,result);
    await this.boundary(`${step.kind}.applied`,operation,this.step(operation,step.stepId));
    if(operation.steps.filter((item)=>["workspace_file","mkdir","index"].includes(item.kind)).every((item)=>item.state==="applied"))operation=await this.commitWorkspaceStage(operation);
    return operation;
  }
  private async provider(operation:RevertOperation,step:RevertStep):Promise<RevertOperation> {
    if(!operation.workspaceProof)operation=await this.commitWorkspaceStage(operation);
    if(!operation.nativePreparation.supported || !this.native)throw new CheckpointError("NEW_CONVERSATION_REQUIRED","Workspace restored; no verified Provider conversation transition is available");
    const request:NativeRevertRequest=step.request ?? {operationId:operation.operationId,requestId:randomUUID(),mode:operation.mode,originalHandle:operation.plan.nativeHandle,preparation:operation.nativePreparation};
    operation=this.dispatch(operation,step.stepId,(next)=>{next.request=request;});await this.boundary("provider.dispatch",operation,this.step(operation,step.stepId));
    const result=await this.deadline(this.native.apply(request));this.checkNativeProof(result,request,true);
    operation=this.refreshAfterNativeJournal(operation,step.stepId,request);
    await this.boundary("provider.external",operation,step);
    operation=this.applied(operation,step.stepId,result,(next)=>{next.nativeProof=result;next.stage="provider_rewound";next.lastCompletedStage="provider_rewound";});
    await this.boundary("provider_rewound",operation);return operation;
  }
  private async commitWorkspaceStage(operation:RevertOperation):Promise<RevertOperation> {
    const inspection=await this.verifyWorkspace(operation);const fingerprint=await this.options.checkpoints.driver(operation.workspaceId).fingerprint(this.capturePaths(operation));
    operation=this.update(operation,"checkpoint.revert.workspace.restored",operation.sessionRevision,(next)=>{
      next.workspaceProof={inspectionBinding:bindingDigest(inspection),workspaceDigest:fingerprint.workspaceDigest,indexDigest:fingerprint.indexDigest,...(fingerprint.head?{head:fingerprint.head}:{}),...(fingerprint.branch?{branch:fingerprint.branch}:{}),observedAt:this.now()};
      next.stage="workspace_restored";next.lastCompletedStage="workspace_restored";
    });await this.boundary("workspace_restored",operation);return operation;
  }
  private async finish(operation:RevertOperation):Promise<RevertOperationResult> {
    await this.authoritative(operation);const inspection=await this.verifyWorkspace(operation);const fingerprint=await this.options.checkpoints.driver(operation.workspaceId).fingerprint(this.capturePaths(operation));
    if(!operation.workspaceProof || fingerprint.workspaceDigest!==operation.workspaceProof.workspaceDigest || fingerprint.indexDigest!==operation.workspaceProof.indexDigest || bindingDigest(inspection)!==operation.workspaceProof.inspectionBinding) throw new CheckpointError("PLAN_STALE","Workspace changed after its restored-stage proof");
    const request=operation.steps.find((step)=>step.kind==="provider")!.request!;const proof=await this.queryNative(request);this.checkNativeProof(proof,request,true);
    const context=await this.authoritative(operation);this.store.assertGate(operation);
    await this.boundary("projection.dispatch",operation);
    const next=structuredClone(operation);next.revision++;next.sessionRevision=context.sessionRevision+1;next.status="completed";next.stage="projection_committed";next.lastCompletedStage="projection_committed";next.newEpoch=randomUUID();next.nativeProof=proof;next.updatedAt=this.now();delete next.errorCode;
    const eventId=randomUUID();
    const receipts:NonNullable<CommandPlan<unknown>["receiptUpdates"]>=operation.commands.map((command)=>({authSubjectId:command.actorId,commandId:command.commandId,state:"completed" as const,response:publicRevertOperation(next),required:true}));
    let parent:RevertOperation|undefined;
    if(operation.parentOperationId) {
      parent=this.store.require(operation.parentOperationId,operation.sessionId);parent.status="rolled_back";parent.errorCode="ROLLED_BACK_TO_SAFETY";parent.revision++;parent.sessionRevision=next.sessionRevision;parent.updatedAt=next.updatedAt;
      for(const command of parent.commands)receipts.push({authSubjectId:command.actorId,commandId:command.commandId,state:"failed",response:publicRevertOperation(parent),required:true});
    }
    const committed=this.project(eventId,()=>this.options.engine.store.commitCommand({sessionId:operation.sessionId,expectedRevision:context.sessionRevision,
      build:()=>({result:undefined,events:[{id:eventId,type:"checkpoint.revert.completed",payload:{operationId:operation.operationId,oldEpoch:operation.plan.epoch,epoch:next.newEpoch,checkpointId:operation.targetCheckpointId},options:{activityState:"idle"}}],receiptUpdates:receipts})}),
      (event)=>{
        this.assertActor(operation);const projected=this.options.projectSuccess(this.store.db,{operation:next,epoch:next.newEpoch!,nativeProof:proof,sourceSequence:event.sequence});
        if(!projected || typeof(projected as {then?:unknown}).then==="function" || projected.epoch!==next.newEpoch || projected.nativeHandleBinding!==bindingDigest(proof.nativeHandle)) throw new CheckpointError("REVERT_PROJECTION_FAILED","New epoch and native binding were not synchronously projected");
        this.store.db.prepare(`INSERT INTO checkpoint_revert_view_boundaries(operation_id,session_id,old_epoch,new_epoch,target_checkpoint_id,safety_checkpoint_id,source_sequence,native_binding,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(next.operationId,next.sessionId,next.plan.epoch,next.newEpoch,next.targetCheckpointId,next.safetyCheckpointId,event.sequence,bindingDigest(proof.nativeHandle),next.updatedAt);
        this.store.releaseGate(operation);this.store.save(next,operation.revision);if(parent)this.store.save(parent,parent.revision-1);
      });
    this.publish(committed?.events ?? []);if(!this.sealed)await this.boundary("projection_committed",next);return {status:"settled",resultCode:"REVERT_COMPLETED",result:publicRevertOperation(next)};
  }
  private async buildSteps(operation:RevertOperation,target:CheckpointManifest,onlyPaths?:Set<string>,knownInspection?:RestoreInspection):Promise<RevertStep[]> {
    const driver=this.options.checkpoints.driver(operation.workspaceId);await driver.verify(target,"workspace");await driver.verify(target,"index");
    const tree=new Map((await driver.listTree(target.workspaceTree!)).map((entry)=>[entry.path,entry]));
    const paths=[...new Set(onlyPaths ? [...onlyPaths]:operation.plan.actions.filter((action)=>action.layer==="workspace").map((action)=>action.path))];
    const targetEntries=new Map(target.entries.map((entry)=>[entry.path,entry]));
    const allParents=new Set<string>();for(const path of paths){validateCheckpointPath(path);const parts=path.split("/");for(let i=1;i<parts.length;i++)allParents.add(parts.slice(0,i).join("/"));}
    const inspection=await this.options.restore.inspect(operation.capabilities,[...paths,...allParents]);
    if(knownInspection && paths.some((path)=>bindingDigest(inspection.files[path])!==bindingDigest(knownInspection.files[path])))throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Safety rollback destinations changed");
    const steps:RevertStep[]=[];const add=(value:Omit<RevertStep,"stepId"|"ordinal"|"attempts"|"state">)=>steps.push({...value,stepId:randomUUID(),ordinal:steps.length,attempts:[],state:"pending"});
    add({kind:"safety_capture"});
    const actions=paths.map((path)=>{
      const retained=tree.get(path);let desired:RestoreTarget={kind:"absent"};
      if(retained){const entry=targetEntries.get(path);if(!entry || !entry.sha256 || entry.bytes===undefined || entry.oid!==retained.oid || entry.mode!==retained.mode || !["file","symlink"].includes(entry.kind))throw new CheckpointError("CAPTURE_UNAVAILABLE","Target manifest and retained tree differ");
        desired={kind:entry.kind as "file"|"symlink",mode:entry.mode,sha256:entry.sha256,bytes:entry.bytes!,oid:entry.oid};}
      return {path,target:desired,expected:inspection.files[path]!,fileId:operation.plan.actions.find((action)=>action.layer==="workspace" && action.path===path)?.fileId ?? digest(`${operation.operationId}\0${path}`)};
    });
    for(const action of actions.filter((item)=>item.target.kind==="absent").sort((a,b)=>b.path.length-a.path.length))add({kind:"workspace_file",...action});
    for(const path of [...allParents].sort((a,b)=>a.split("/").length-b.split("/").length || a.localeCompare(b))) {
      const state=inspection.files[path]!;
      if(state.kind==="file" || state.kind==="symlink")throw new CheckpointError("FILE_DIRECTORY_COLLISION","Restore has a file or symlink parent collision");
      if(state.kind==="absent" && actions.some((action)=>action.target.kind!=="absent" && action.path.startsWith(path+"/")))add({kind:"mkdir",path,target:{kind:"directory"},expected:state});
    }
    for(const action of actions.filter((item)=>item.target.kind!=="absent").sort((a,b)=>a.path.localeCompare(b.path)))add({kind:"workspace_file",...action});
    add({kind:"index",expected:inspection.indexState,expectedIndexDigest:inspection.indexDigest});add({kind:"provider"});
    const withArtifacts=await this.options.restore.inspect(operation.capabilities,[...paths,...allParents],steps);
    for(const step of steps)if(step.kind==="workspace_file" || step.kind==="index") {
      step.artifact=withArtifacts.artifacts[step.stepId]!;
      let ownedPredecessorLock=false;
      if(step.kind==="index" && operation.parentOperationId && knownInspection) {
        const predecessor=this.store.require(operation.parentOperationId,operation.sessionId).steps.find((item)=>item.kind==="index")!;
        const originalArtifact=knownInspection.artifacts[predecessor.stepId];
        ownedPredecessorLock=Boolean(originalArtifact?.sameLockInode && originalArtifact.lockOwner?.sha256===digest(predecessor.stepId) &&
          bindingDigest(step.artifact.indexLock)===bindingDigest(originalArtifact.indexLock) && step.artifact.temporary?.kind==="absent" && step.artifact.owner?.kind==="absent" && step.artifact.lockOwner?.kind==="absent");
      }
      if(this.hasArtifacts(step.artifact) && !ownedPredecessorLock)throw new CheckpointError("RESTORE_ARTIFACT_COLLISION","Generated action artifact name is occupied");
    }
    return steps;
  }
  private dispatch(operation:RevertOperation,stepId:string,mutate?:(step:RevertStep)=>void):RevertOperation {
    const attemptId=randomUUID();
    return this.update(operation,"checkpoint.revert.step.dispatching",operation.sessionRevision,(next)=>{
      const step=this.step(next,stepId);if(step.state!=="pending")throw new CheckpointError("RECOVERY_REQUIRED","Only a known pending step can dispatch");
      mutate?.(step);step.state="dispatching";step.attempts.push({attemptId,dispatchAt:this.now(),state:"dispatching",commandIntentId:operation.commands.at(-1)!.intentId,lease:operation.lease,inputBinding:bindingDigest({expected:step.expected,artifact:step.artifact,expectedIndexDigest:step.expectedIndexDigest,desiredIndexDigest:step.desiredIndexDigest}),...(step.request?{request:step.request}: {})});
    },{stepId,attemptId});
  }
  private applied(operation:RevertOperation,stepId:string,result:unknown,mutate?:(operation:RevertOperation)=>void):RevertOperation {
    return this.update(operation,"checkpoint.revert.step.applied",operation.sessionRevision,(next)=>{
      const step=this.step(next,stepId);if(step.state!=="dispatching")throw new CheckpointError("REVERT_STEP_INVALID","Step has no durable dispatch marker");
      step.state="applied";step.result=result;const attempt=step.attempts.at(-1)!;attempt.state="applied";attempt.completedAt=this.now();attempt.result=result;mutate?.(next);
    },{stepId});
  }
  private partial(operation:RevertOperation,code:string):RevertOperation {
    return this.update(operation,"checkpoint.revert.partial_failure",this.options.engine.store.getSession(operation.sessionId)!.revision,(next)=>{
      next.status="blocked";next.stage="partial_failure";next.errorCode=code;
      for(const step of next.steps)if(step.state==="dispatching") {step.state="outcome_unknown";const attempt=step.attempts.at(-1)!;attempt.state="outcome_unknown";attempt.completedAt=this.now();attempt.errorCode=code;}
    },{errorCode:code},operation.commands.filter((command)=>this.options.engine.store.getCommandReceipt(command.actorId,command.commandId)?.state==="accepted")
      .map((command)=>({authSubjectId:command.actorId,commandId:command.commandId,state:"outcome_unknown" as const,response:{operationId:operation.operationId,resultCode:code},required:true})));
  }
  private update(operation:RevertOperation,type:string,expectedSessionRevision:number,mutate:(next:RevertOperation)=>void,payload:Record<string,unknown>={},receiptUpdates?:CommandPlan<unknown>["receiptUpdates"]):RevertOperation {
    this.assertOpen();const next=structuredClone(operation);next.revision++;next.sessionRevision=expectedSessionRevision+1;next.updatedAt=this.now();mutate(next);
    const eventId=randomUUID();const committed=this.project(eventId,()=>this.options.engine.store.commitCommand({sessionId:operation.sessionId,expectedRevision:expectedSessionRevision,
      build:()=>({result:undefined,events:[{id:eventId,type,payload:{operationId:operation.operationId,...payload},options:{activityState:"outcome_unknown"}}],...(receiptUpdates?{receiptUpdates}: {})})}),()=>{
      if(type==="checkpoint.revert.step.dispatching" || type==="checkpoint.revert.native.claimed" || type==="checkpoint.revert.native.receipt")this.assertActor(operation);
      if(type==="checkpoint.revert.native.claimed" || type==="checkpoint.revert.native.receipt") {
        const mutation=next.steps.find((step)=>step.kind==="provider")?.attempts.at(-1)?.nativeMutation?.mutation;
        if(!mutation)throw new CheckpointError("NATIVE_REQUEST_UNJOURNALLED","Native journal mutation is missing");
        this.assertNativeMutationRequest(operation,mutation);
      }
      this.store.assertGate(operation);this.store.save(next,operation.revision);
      if(next.safetyCheckpointId)this.options.checkpoints.store.pin(next.safetyCheckpointId,"revert",next.operationId);
    });this.publish(committed?.events ?? []);return next;
  }
  private assertActor(operation:RevertOperation):void {
    const readiness=this.options.assertRestoreWriteReady(this.store.db) as unknown;
    if(readiness && typeof(readiness as {then?:unknown}).then==="function") {void Promise.resolve(readiness).catch(()=>{});throw new CheckpointError("RESTORE_READINESS_MUST_BE_SYNCHRONOUS","Restore readiness must share the SQL boundary");}
    const result=this.options.revalidateActorInCommit(operation) as unknown;
    if(result && typeof(result as {then?:unknown}).then==="function") {void Promise.resolve(result).catch(()=>{});throw new CheckpointError("ACTOR_REVALIDATION_MUST_BE_SYNCHRONOUS","Actor authorization must share the SQL boundary");}
  }
  private publish(events:readonly SessionEvent[]):void {
    if(this.sealed)return;try {const result=this.options.publishCommitted?.(events) as unknown;if(result && typeof(result as {then?:unknown}).then==="function")void Promise.resolve(result).catch(()=>{});} catch { /* Durable source events remain replayable. */ }
  }
  private project<T>(eventId:string,commit:()=>T,apply:(event:SessionEvent)=>void):T {
    this.assertOpen();const unsubscribe=this.options.engine.store.registerCommitHook((events)=>{const event=events.find((item)=>item.id===eventId);if(event)apply(event);});
    try{return commit();}finally{unsubscribe();}
  }
  private async authoritative(operation:RevertOperation):Promise<CheckpointPreviewContext> {
    const context=await this.resolve(operation.sessionId,operation.actorId);this.checkContext(operation,context,true);
    if(context.sessionRevision!==operation.sessionRevision)throw new CheckpointError("PLAN_STALE","Session changed during operation");
    if(bindingDigest(context.lease)!==bindingDigest(operation.lease))throw new CheckpointError("PLAN_STALE","Execution lease changed during operation");
    this.store.assertGate(operation);return context;
  }
  private async acquire(operation:RevertOperation):Promise<RevertAcquisition> {
    const acquired=await this.options.acquire({sessionId:operation.sessionId,actorId:operation.actorId,workspaceId:operation.workspaceId,previousLease:operation.lease});
    const context=await this.resolve(operation.sessionId,operation.actorId);this.sameContext(acquired.context,context);
    if(bindingDigest(operation.lease)!==bindingDigest(context.lease)) {
      const proof=acquired.succession;
      if(!proof || bindingDigest(proof.previous)!==bindingDigest(operation.lease) || bindingDigest(proof.current)!==bindingDigest(context.lease) || proof.current.workspaceId!==operation.workspaceId || proof.current.generation<=proof.previous.generation || !await this.options.verifyLeaseSuccession?.(proof))throw new CheckpointError("PLAN_STALE","Lease succession has no trusted absence-of-writer proof");
    }
    return acquired;
  }
  private async resolve(sessionId:string,actorId:string):Promise<CheckpointPreviewContext> {
    this.assertOpen();const context=await this.options.resolveContext(sessionId,actorId);this.assertOpen();
    if(context.sessionId!==sessionId || context.actorId!==actorId)throw new CheckpointError("REVERT_SCOPE_MISMATCH","Context belongs to another actor or Session");
    await this.options.checkpoints.assertLease(context);return context;
  }
  private checkContext(operation:RevertOperation,context:CheckpointPreviewContext,checkRuntime:boolean):void {
    if(context.activeTurnId || context.workspaceId!==operation.workspaceId || context.epoch!==operation.plan.epoch || bindingDigest(context.nativeHandle)!==operation.plan.nativeHandleBinding ||
      checkRuntime && context.runtimeGeneration!==operation.commands.at(-1)!.dispatchContext.runtimeGeneration)throw new CheckpointError("PLAN_STALE","Original native, epoch or execution binding changed");
  }
  private contextBinding(context:CheckpointPreviewContext):string {return bindingDigest({sessionId:context.sessionId,actorId:context.actorId,workspaceId:context.workspaceId,lease:context.lease,sessionRevision:context.sessionRevision,epoch:context.epoch,runtimeGeneration:context.runtimeGeneration,nativeHandle:context.nativeHandle,activeTurnId:context.activeTurnId});}
  private sameContext(a:CheckpointPreviewContext,b:CheckpointPreviewContext):void {if(this.contextBinding(a)!==this.contextBinding(b))throw new CheckpointError("PLAN_STALE","Authoritative facts changed while checking operation");}
  private checkExpiry(operation:RevertOperation):void {
    const expires=operation.commands.at(-1)?.kind==="execute"?operation.plan.expiresAt:operation.recoveryExpiresAt;
    if(operation.plan.policyVersion!==CHECKPOINT_POLICY_VERSION || !expires || this.date().getTime()>=new Date(expires).getTime())throw new CheckpointError("PLAN_STALE","Execution plan or fresh recovery authorization expired");
  }
  private async verifyRefs(operation:RevertOperation):Promise<void> {
    const driver=this.options.checkpoints.driver(operation.workspaceId);
    for(const id of new Set([operation.targetCheckpointId,operation.currentCheckpointId,...(operation.safetyCheckpointId?[operation.safetyCheckpointId]:[])])) {
      const capture=this.options.checkpoints.store.require(id,operation.sessionId);
      if(capture.workspaceId!==operation.workspaceId || capture.status!=="complete" || capture.samplingConsistency!=="stable")throw new CheckpointError("CAPTURE_UNAVAILABLE","Operation snapshot is not exact");
      await driver.verify(capture,"workspace");await driver.verify(capture,"index");
    }
    await this.options.restore.verifyRepository(driver.workspace,operation.capabilities);
  }
  private inspect(operation:RevertOperation):Promise<RestoreInspection> {return this.options.restore.inspect(operation.capabilities,operation.steps.flatMap((step)=>step.cleanup?.originalStep.path ? [step.cleanup.originalStep.path]:step.path ? [step.path]:[]),operation.steps);}
  private capturePaths(operation:RevertOperation):string[] {return [...new Set([...operation.plan.actions.map((action)=>action.path),...this.options.checkpoints.store.require(operation.currentCheckpointId,operation.sessionId).entries.map((entry)=>entry.path)])];}
  private async verifyWorkspace(operation:RevertOperation):Promise<RestoreInspection> {
    const inspection=await this.inspect(operation);
    for(const step of operation.steps.filter((item)=>item.kind==="workspace_file" || item.kind==="mkdir"))if(!sameFileContent(inspection.files[step.path!]!,step.target!))throw new CheckpointError("FILE_COLLISION","A restored destination differs from its planned bytes");
    const index=operation.steps.find((step)=>step.kind==="index")!;
    if(index.state!=="applied" || !index.desiredIndexDigest || inspection.indexDigest!==index.desiredIndexDigest)throw new CheckpointError("INDEX_COLLISION","Independent staged index differs from the prepared target");
    if(Object.values(inspection.artifacts).some((artifact)=>this.hasArtifacts(artifact)))throw new CheckpointError("RESTORE_ARTIFACT_COLLISION","Interrupted owned artifacts need explicit reconciliation");
    const original=this.options.checkpoints.store.require(operation.currentCheckpointId,operation.sessionId);
    const sampled=await this.options.checkpoints.driver(operation.workspaceId).fingerprint(this.capturePaths(operation));
    if(sampled.head!==original.head || sampled.branch!==original.branch)throw new CheckpointError("PLAN_STALE","HEAD or branch changed; controlled restore never resets them");
    return inspection;
  }
  private hasArtifacts(artifact:RevertStep["artifact"]):boolean {return Boolean(artifact && [artifact.temporary,artifact.owner,artifact.lockOwner,artifact.indexLock].some((state)=>state && state.kind!=="absent"));}
  private findSafety(operation:RevertOperation):CheckpointManifest|undefined {
    return this.options.checkpoints.store.list(operation.sessionId,"safety").find((capture)=>capture.turnId===operation.operationId && capture.attemptId===operation.commands[0]!.attemptId && capture.status==="complete" && capture.samplingConsistency==="stable");
  }
  private attachSafety(operation:RevertOperation,safety:CheckpointManifest):void {operation.safetyCheckpointId=safety.checkpointId;}
  /** Reads the same persisted request/attempt that Worker committed before apply.
   * No parallel SQL journal, constructor DDL or alternate projection writer. */
  private nativeOperation(operationId:string):RevertOperation {
    this.assertOpen();
    const row=this.store.db.prepare("SELECT session_id FROM checkpoint_revert_operations WHERE operation_id=?").get(operationId) as {session_id:string}|undefined;
    if(!row)throw new CheckpointError("NATIVE_REQUEST_UNJOURNALLED","Native mutation has no accepted Revert operation");
    return this.store.require(operationId,row.session_id);
  }
  private nativeRecord(operation:RevertOperation,requestId:string) {
    const records=operation.steps.flatMap((step)=>step.kind==="provider" ? step.attempts.filter((attempt)=>attempt.nativeMutation?.mutation.requestId===requestId).map((attempt)=>({step,attempt,record:attempt.nativeMutation!})):[]);
    if(records.length>1)throw new CheckpointError("NATIVE_REQUEST_REBOUND","Native request has multiple durable dispatch claims");
    return records[0];
  }
  private async getNativeMutation(operationId:string,requestId:string) {
    const operation=this.nativeOperation(operationId),record=this.nativeRecord(operation,requestId)?.record;
    if(operation.steps.some((step)=>step.kind==="provider" && step.attempts.some((attempt)=>attempt.nativeMutation && attempt.nativeMutation.mutation.requestId!==requestId)))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Operation is already bound to a different original native request");
    if(!record)return undefined;
    if(record.mutation.operationId!==operationId)throw new CheckpointError("NATIVE_REQUEST_REBOUND","Native request belongs to another operation");
    return structuredClone({mutation:record.mutation,...(record.receipt?{receipt:record.receipt}:{})});
  }
  /** Original execution context, stable across Service recreation and owner takeover.
   * Query inspects these old rows; execute separately requires the active owner. */
  nativeMutationContext(mutation:NativeRevertMutation):DispatchContext {
    const operation=this.nativeOperation(mutation.operationId),found=this.nativeRecord(operation,mutation.requestId);
    if(!found||bindingDigest(found.record.mutation)!==bindingDigest(mutation))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Native helper context has no exact original claim");
    const command=operation.commands.find((item)=>item.intentId===found.attempt.commandIntentId);
    if(!command)throw new CheckpointError("NATIVE_REQUEST_REBOUND","Original helper command binding is unavailable");
    return {...structuredClone(command.dispatchContext),flyxTurnId:mutation.operationId,attemptId:mutation.requestId,runtimeId:`${command.dispatchContext.runtimeId}:native-revert`};
  }
  /** Synchronous final pre-spawn/pre-RPC authorization. Concrete managed ports also
   * assert the actual in-memory checkout lease and current executable identity. */
  assertNativeMutationDispatch(mutation:NativeRevertMutation):void {
    this.assertOpen();
    this.store.db.transaction(()=>{
      this.options.engine.store.assertWriterOwner();
      const operation=this.nativeOperation(mutation.operationId),found=this.nativeRecord(operation,mutation.requestId);
      if(!found||bindingDigest(found.record.mutation)!==bindingDigest(mutation)||operation.status!=="running"||found.step.state!=="dispatching"||found.attempt.state!=="dispatching"||found.attempt.attemptId!==found.step.attempts.at(-1)!.attemptId||this.options.engine.store.getSession(operation.sessionId)?.revision!==operation.sessionRevision)throw new CheckpointError("NATIVE_OUTCOME_UNKNOWN","Original native mutation no longer owns its dispatch gate");
      this.assertNativeMutationRequest(operation,mutation);this.assertActor(operation);this.store.assertGate(operation);
    })();
  }
  private assertNativeMutationRequest(operation:RevertOperation,mutation:NativeRevertMutation):RevertStep {
    const step=operation.steps.find((item)=>item.kind==="provider"),attempt=step?.attempts.at(-1),request=step?.request;
    if(!request || !attempt?.request || request.operationId!==operation.operationId || mutation.operationId!==operation.operationId ||
      request.requestId!==mutation.requestId || bindingDigest(request)!==mutation.requestDigest || bindingDigest(attempt.request)!==mutation.requestDigest ||
      attempt.commandIntentId!==operation.commands.at(-1)!.intentId || bindingDigest(attempt.lease)!==bindingDigest(operation.lease))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Native mutation differs from its exact persisted Provider step");
    // JSON1 lookup is read-only; uniqueness is enforced under the Engine's owned
    // writer and gate before the following transaction commits the actual claim.
    const rows=this.store.db.prepare("SELECT operation_id FROM checkpoint_revert_step_attempts WHERE json_extract(attempt_json,'$.request.requestId')=? OR json_extract(attempt_json,'$.nativeMutation.mutation.requestId')=?").all(mutation.requestId,mutation.requestId) as {operation_id:string}[];
    if(rows.some((row)=>row.operation_id!==operation.operationId))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Request identity is already bound to another operation");
    return step;
  }
  private async claimNativeMutation(input:NativeRevertMutation):Promise<"claimed"|"existing"> {
    const mutation=structuredClone(input),operation=this.nativeOperation(mutation.operationId);
    const existing=this.nativeRecord(operation,mutation.requestId);
    if(existing) {
      if(bindingDigest(existing.record.mutation)!==bindingDigest(mutation))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Native dispatch identity changed after its durable claim");
      return "existing";
    }
    const step=this.assertNativeMutationRequest(operation,mutation),attempt=step.attempts.at(-1)!;
    if(operation.status!=="running" || step.state!=="dispatching" || attempt.state!=="dispatching" || attempt.nativeMutation)throw new CheckpointError("NATIVE_REQUEST_UNJOURNALLED","Only the active original dispatch attempt may claim a native mutation");
    await this.authoritative(operation);
    this.update(operation,"checkpoint.revert.native.claimed",operation.sessionRevision,(next)=>{
      this.step(next,step.stepId).attempts.at(-1)!.nativeMutation={mutation,claimOperationRevision:next.revision,claimSessionRevision:next.sessionRevision,claimedAt:this.now()};
    },{stepId:step.stepId,requestId:mutation.requestId});
    return "claimed";
  }
  private async recordNativeMutation(input:NativeRevertMutation,inputReceipt:NativeRevertMutationReceipt):Promise<void> {
    const mutation=structuredClone(input),receipt=structuredClone(inputReceipt),operation=this.nativeOperation(mutation.operationId);
    const found=this.nativeRecord(operation,mutation.requestId);
    if(!found || bindingDigest(found.record.mutation)!==bindingDigest(mutation) || receipt.operationId!==mutation.operationId || receipt.requestId!==mutation.requestId || receipt.requestDigest!==mutation.requestDigest || !receipt.sourceId || !["completed","not_dispatched","unknown"].includes(receipt.state))throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH","Native receipt is not bound to the original durable claim");
    if(found.record.receipt) {
      if(bindingDigest(found.record.receipt)!==bindingDigest(receipt))throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH","A persisted original helper receipt cannot be replaced");
      return;
    }
    const step=this.assertNativeMutationRequest(operation,mutation);
    if(operation.status!=="running" || step.state!=="dispatching" || found.attempt.attemptId!==step.attempts.at(-1)!.attemptId)throw new CheckpointError("NATIVE_OUTCOME_UNKNOWN","Original native dispatch is no longer active");
    await this.authoritative(operation);
    this.update(operation,"checkpoint.revert.native.receipt",operation.sessionRevision,(next)=>{
      const record=this.step(next,step.stepId).attempts.at(-1)!.nativeMutation!;
      record.receipt=receipt;record.receiptOperationRevision=next.revision;record.receiptSessionRevision=next.sessionRevision;
    },{stepId:step.stepId,requestId:mutation.requestId});
  }
  private refreshAfterNativeJournal(previous:RevertOperation,stepId:string,request:NativeRevertRequest):RevertOperation {
    const current=this.store.require(previous.operationId,previous.sessionId,previous.actorId),before=this.step(previous,stepId).attempts.at(-1)!,after=this.step(current,stepId).attempts.at(-1)!;
    if(after.attemptId!==before.attemptId || bindingDigest(after.request)!==bindingDigest(request))throw new CheckpointError("NATIVE_REQUEST_REBOUND","Provider attempt changed during its native wait");
    const first=before.nativeMutation,last=after.nativeMutation;
    const claimAdded=!first&&Boolean(last),receiptAdded=!first?.receipt&&Boolean(last?.receipt),count=Number(claimAdded)+Number(receiptAdded);
    const normalized=(value:RevertOperation)=>{
      const copy=structuredClone(value);copy.revision=0;copy.sessionRevision=0;copy.updatedAt="";
      delete this.step(copy,stepId).attempts.at(-1)!.nativeMutation;return copy;
    };
    if(current.revision!==previous.revision+count || current.sessionRevision!==previous.sessionRevision+count || bindingDigest(normalized(current))!==bindingDigest(normalized(previous)) ||
      claimAdded && (last!.claimOperationRevision!==previous.revision+1 || last!.claimSessionRevision!==previous.sessionRevision+1) ||
      receiptAdded && (last!.receiptOperationRevision!==previous.revision+count || last!.receiptSessionRevision!==previous.sessionRevision+count) ||
      first && last && (bindingDigest(first.mutation)!==bindingDigest(last.mutation) || first.claimOperationRevision!==last.claimOperationRevision || first.claimSessionRevision!==last.claimSessionRevision) ||
      last && (last.mutation.requestDigest!==bindingDigest(request) || last.mutation.requestId!==request.requestId))throw new CheckpointError("PLAN_STALE","Operation changed outside the exact native journal commits");
    this.store.assertGate(current);return current;
  }
  private async prepareNative(mode:RevertOperation["mode"],plan:CheckpointPreviewPlan,target:CheckpointManifest):Promise<NativeRevertPreparation> {
    if(!this.native)return {supported:false,reason:"provider_transition_unavailable"};
    const preparation=await this.native.prepare({mode,originalHandle:plan.nativeHandle,targetHandle:target.nativeHandle,checkpointId:target.checkpointId,checkpointPhase:target.phase});
    if(preparation.supported && (preparation.originalBinding!==plan.nativeHandleBinding || preparation.targetBinding!==bindingDigest({checkpointId:target.checkpointId,nativeHandle:target.nativeHandle,phase:target.phase}) ||
      !preparation.capability.evidenceId || !preparation.capability.verifiedVersion || !preparation.capability.driverVersion || preparation.capability.kind!==(mode==="revert"?"conversation-rewind":"new-conversation")))throw new CheckpointError("PROVIDER_CAPABILITY_UNVERIFIED","Native transition has no exact verified binding");
    return preparation;
  }
  private checkNativeProof(proof:NativeRevertProof,request:NativeRevertRequest,requireApplied:boolean):void {
    if(proof.requestId!==request.requestId || proof.originalBinding!==request.preparation.originalBinding || proof.targetBinding!==request.preparation.targetBinding || !proof.proofId || !Number.isFinite(new Date(proof.observedAt).getTime()) ||
      this.date().getTime()-new Date(proof.observedAt).getTime()>Math.min(120_000,this.options.evidenceTtlMs ?? 30_000) || new Date(proof.observedAt).getTime()>this.date().getTime()+1000)throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH","Native evidence is not bound to the exact original request");
    if(requireApplied && (proof.state!=="applied" || !proof.quiescent || proof.pendingRequest || proof.nativeHandle===undefined || request.mode==="workspaceRestore" && bindingDigest(proof.nativeHandle)===request.preparation.originalBinding))throw new CheckpointError("NATIVE_OUTCOME_UNKNOWN","Provider did not prove its conversation transition completed");
  }
  private async queryNative(request:NativeRevertRequest):Promise<NativeRevertProof> {
    if(!this.native)throw new CheckpointError("PROVIDER_REWIND_UNSUPPORTED","Native request cannot be queried");
    return this.deadline(this.native.query(request));
  }
  private async deadline<T>(work:Promise<T>):Promise<T> {
    this.producers.add(work);void work.finally(()=>this.producers.delete(work)).catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new CheckpointError("NATIVE_OUTCOME_UNKNOWN","Native transition timed out; it may still be pending")),Math.max(1,this.options.nativeTimeoutMs ?? 30_000));})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private resumeBlock(operation:RevertOperation,evidence:RevertRecoveryEvidence):string|undefined {
    for(const step of operation.steps) {
      if(step.state!=="dispatching" && step.state!=="outcome_unknown")continue;
      if(step.kind==="owned_cleanup")continue;
      if(step.kind==="provider") {const proof=evidence.nativeProof;if(!proof || proof.state==="unknown" || !proof.quiescent || proof.pendingRequest)return "NATIVE_OUTCOME_UNKNOWN";}
      else if(step.kind==="safety_capture") {if(!this.findSafety(operation) && (evidence.workspaceDigest!==operation.plan.expectedWorkspaceDigest || evidence.inspection.indexDigest!==operation.plan.expectedIndexDigest) && !operation.parentOperationId)return "SAFETY_CHECKPOINT_UNAVAILABLE";}
      else if(step.kind==="index") {if(evidence.inspection.indexDigest!==step.expectedIndexDigest && evidence.inspection.indexDigest!==step.desiredIndexDigest)return "INDEX_COLLISION";}
      else {const actual=evidence.inspection.files[step.path!];if(!actual || !sameFileContent(actual,step.expected!) && !sameFileContent(actual,step.target!))return "FILE_COLLISION";}
    }
    return undefined;
  }
  private async validateEvidence(operation:RevertOperation,input:RecoveryInput):Promise<{evidence:RevertRecoveryEvidence;context:CheckpointPreviewContext}> {
    if(this.running.has(operation.operationId) || operation.status==="completed" || operation.status==="rolled_back")throw new CheckpointError("RECOVERY_BLOCKED","Operation cannot enter recovery now");
    const evidence=this.store.evidence(input.evidenceId,operation.operationId,operation.sessionId,operation.actorId);
    if(evidence.consumedBy || evidence.operationRevision!==operation.revision || evidence.sessionRevision!==input.expectedSessionRevision || this.date().getTime()>=new Date(evidence.expiresAt).getTime())throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Recovery evidence expired or changed");
    this.store.assertGate(operation);const acquisition=await this.acquire(operation);const context=acquisition.context;this.checkContext(operation,context,false);
    if(context.sessionRevision!==input.expectedSessionRevision || this.contextBinding(context)!==evidence.contextBinding || bindingDigest(context.lease)!==bindingDigest(evidence.lease))throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Session or lease changed after inspection");
    const quiescence=await this.options.proveQuiescence(operation);if(!quiescence.proven || quiescence.proofId!==evidence.quiescenceProofId)throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Original writer stop evidence changed");
    await this.verifyRefs(operation);const inspection=await this.inspect(operation);
    const fingerprint=await this.options.checkpoints.driver(operation.workspaceId).fingerprint(this.capturePaths(operation));
    if(bindingDigest(inspection)!==bindingDigest(evidence.inspection) || fingerprint.workspaceDigest!==evidence.workspaceDigest || fingerprint.head!==evidence.head || fingerprint.branch!==evidence.branch)throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Workspace changed after recovery inspection");
    if(evidence.nativeProof) {const request=operation.steps.find((step)=>step.kind==="provider")!.request!;const fresh=await this.queryNative(request);this.checkNativeProof(fresh,request,false);
      if(bindingDigest({...fresh,observedAt:null,proofId:null})!==bindingDigest({...evidence.nativeProof,observedAt:null,proofId:null}))throw new CheckpointError("RECOVERY_EVIDENCE_STALE","Native request facts changed after inspection");}
    this.sameContext(context,await this.resolve(operation.sessionId,operation.actorId));return {evidence,context};
  }
  private command(context:CheckpointPreviewContext,operationId:string,attemptId:string,intentId:string,commandId:string,requestHash:string,kind:RevertCommand["kind"]):RevertCommand {
    const dispatchContext=this.options.dispatchContextFor(context,operationId,attemptId);
    if(dispatchContext.sessionId!==context.sessionId || dispatchContext.flyxTurnId!==operationId || dispatchContext.attemptId!==attemptId || dispatchContext.runtimeGeneration!==context.runtimeGeneration || !dispatchContext.runtimeId || !dispatchContext.hostOwnerId || !Number.isSafeInteger(dispatchContext.hostOwnerGeneration))throw new CheckpointError("REVERT_INTENT_FENCE_MISMATCH","Host returned an invalid immutable operation binding");
    return {actorId:context.actorId,commandId,requestHash,intentId,attemptId,dispatchContext,kind,acceptedRevision:context.sessionRevision+1};
  }
  private intent(operation:RevertOperation,command:RevertCommand):ExecutionIntentInput {return {id:command.intentId,sessionId:operation.sessionId,authSubjectId:command.actorId,commandId:command.commandId,ordinal:0,actorKind:"device",kind:REVERT_INTENT_KIND,resourceId:operation.operationId,payload:{operationId:operation.operationId},requestHash:command.requestHash,requestFormatVersion:2,runtimeGeneration:command.dispatchContext.runtimeGeneration,attemptId:command.attemptId,dispatchContext:command.dispatchContext};}
  private request(method:string,payload:{actorId:string;sessionId:string;commandId:string},workspaceId:string):CommandRequest {
    const {actorId,commandId,...normalized}=payload;return {authSubjectId:actorId,commandId,method,targetSessionId:payload.sessionId,requestFormatVersion:2,requestHash:hashCommandRequest(method,normalized,{requestFormatVersion:2,targetSessionId:payload.sessionId,workspaceId})};
  }
  private receipt(request:CommandRequest,result:CheckpointRevertOperation):CommandReceiptInput {return {authSubjectId:request.authSubjectId,commandId:request.commandId,method:request.method,requestHash:request.requestHash,requestFormatVersion:2,targetSessionId:request.targetSessionId!,state:"accepted",response:result};}
  private reuse(request:CommandRequest):CheckpointRevertOperation|undefined {const receipt=this.options.engine.store.getCommandReceipt(request.authSubjectId,request.commandId);if(!receipt)return undefined;assertReceiptRequest(receipt,request);return this.options.engine.commitRequest<CheckpointRevertOperation>(request,()=>{throw new Error("RECEIPT_DISAPPEARED");}).result;}
  private step(operation:RevertOperation,id:string):RevertStep {return operation.steps.find((step)=>step.stepId===id)!;}
  private boundary(boundary:string,operation:RevertOperation,step?:RevertStep):Promise<void> {this.assertOpen();return Promise.resolve(this.options.onBoundary?.(boundary,structuredClone(operation),step?structuredClone(step):undefined));}
  private date():Date {return this.options.now?.() ?? new Date();}
  private now():string {return this.date().toISOString();}
}

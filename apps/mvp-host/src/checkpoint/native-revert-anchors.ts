import { SessionNativeHandleSchema, type SessionNativeHandle } from "@flyx/mvp-protocol";
import { bindingDigest } from "./git-driver.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ManagedNativeRevertPort, NativeRevertDriverOptions, NativeRevertHandle } from "./native-revert-drivers.js";
import { CheckpointError, type CheckpointContext, type CheckpointPhase } from "./types.js";

function matches(handle:NativeRevertHandle,binding:SessionNativeHandle):boolean {return handle.provider===binding.provider&&handle.providerInstanceId===binding.providerInstanceId&&handle.workspaceId===binding.workspaceId&&handle.nativeSessionId===binding.nativeSessionId;}
/** A queued Flyx Turn is fine: this sample concerns actual native producers and
 * the persisted native prefix, before any prompt is delivered. */
export function createNativeCheckpointAnchorCapture(options:{port:ManagedNativeRevertPort;metadataFor:(binding:SessionNativeHandle,context:CheckpointContext)=>NativeRevertHandle|undefined}) {
  return async(context:CheckpointContext,_phase:CheckpointPhase):Promise<NativeRevertHandle|undefined>=>{
    const binding=SessionNativeHandleSchema.safeParse(context.nativeHandle);
    if(!binding.success)return undefined;
    const metadata=options.metadataFor(binding.data,context);
    if(!metadata)return undefined;
    if(!matches(metadata,binding.data))throw new CheckpointError("NATIVE_HANDLE_INVALID","Private checkpoint metadata belongs to another native binding");
    if(context.turnId&&context.attemptId&&(!metadata.captureContext||metadata.captureContext.sessionId!==context.sessionId||metadata.captureContext.flyxTurnId!==context.turnId||metadata.captureContext.attemptId!==context.attemptId||metadata.captureContext.runtimeGeneration!==context.runtimeGeneration))throw new CheckpointError("NATIVE_CAPTURE_CONTEXT_REQUIRED","Native checkpoint helper must share the exact original Turn/attempt producer inventory");
    const history=await options.port.read(metadata);
    if(history.provider!==metadata.provider||history.nativeSessionId!==metadata.nativeSessionId||history.verifiedVersion!==metadata.verifiedVersion||!history.sourceId||!Array.isArray(history.entries)||history.entries.some((entry)=>!entry.id||!entry.digest)||new Set(history.entries.map((entry)=>entry.id)).size!==history.entries.length)throw new CheckpointError("NATIVE_EVIDENCE_MISMATCH","Native capture reader returned another persisted history");
    if(!history.quiescent||history.pendingRequest)throw new CheckpointError("NATIVE_CAPTURE_NOT_QUIESCENT","Native producers have not stopped at the file boundary",{producerFailure:{code:"NATIVE_CAPTURE_NOT_QUIESCENT",state:"unknown",producerStopped:false,requestBinding:bindingDigest({binding:binding.data,sourceId:history.sourceId}),operation:{kind:"native-history"}}});
    const result=structuredClone(metadata),last=history.entries.at(-1),previous=history.entries.at(-2);
    delete result.nativeTurnId;delete result.nativeMessageId;delete result.nativeBeforeMessageId;
    if(metadata.provider==="codex"&&last)result.nativeTurnId=last.id;
    if(metadata.provider==="claude") {if(last)result.nativeMessageId=last.id;if(previous)result.nativeBeforeMessageId=previous.id;}
    result.historyBoundary={v:1,provider:metadata.provider,entryCount:history.entries.length,entriesDigest:bindingDigest(history.entries),sourceId:history.sourceId,...(last?{lastId:last.id}:{})};
    return result;
  };
}
/** Target anchors are immutable checkpoint facts, never current/latest native rows. */
export function checkpointNativeHandleResolver(options:{checkpoints:CheckpointStore;current:(binding:SessionNativeHandle)=>NativeRevertHandle|undefined}):NativeRevertDriverOptions["resolveHandle"] {
  return(binding,context)=>{
    if(context.role==="original")return options.current(binding);
    const checkpoint=options.checkpoints.get(context.checkpointId),metadata=checkpoint?.nativeHistoryHandle;
    if(!checkpoint||checkpoint.phase!==context.checkpointPhase||checkpoint.nativeHandleBinding!==bindingDigest(binding)||!metadata||!matches(metadata,binding))return undefined;
    return structuredClone(metadata);
  };
}

import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry } from "../lifecycle/managed-process-registry.js";
import type { ManagedProcessRecord, ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import type { AppServerClient, AppServerClientHandlers, JsonObject } from "../codex/app-server-client.js";
import type { DispatchContext } from "../provider/types.js";
import type { PreparedNativeRuntime } from "../provider/managed-runtime.js";
import { runNativeRevertHelper, type ClaudeNativeHistorySdk } from "../provider/native-revert-helper.js";
import { HostManagedNativeRevertPort, parseClaudeRevertHistory, parseCodexRevertHistory } from "./managed-native-revert-port.js";
import type { NativeRevertHandle, NativeRevertMutation, NativeRevertMutationJournal, NativeRevertMutationReceipt } from "./native-revert-drivers.js";

const handle:NativeRevertHandle={provider:"codex",providerInstanceId:"instance",workspaceId:"workspace",nativeSessionId:"thread",workspacePath:"/workspace",configurationFingerprint:"configuration",verifiedVersion:"native-v1"};
const context:DispatchContext={hostOwnerId:"owner",hostOwnerGeneration:1,sessionId:"session",flyxTurnId:"operation",runtimeId:"runtime",runtimeGeneration:1,attemptId:"request"};
const mutation:NativeRevertMutation={operationId:"operation",requestId:"request",requestDigest:"request-digest",originalHandle:handle,command:{method:"thread/rollback",threadId:"thread",numTurns:1}};
function fixture(options:{unknownStop?:boolean;deniedAtRpc?:boolean;nativeRunning?:boolean}={}) {
  const calls:{method:string;params:JsonObject}[]=[],rejects:unknown[]=[];let preparations=0,assertions=0,closes=0;
  const record:ManagedProcessRecord={...context,id:"original-process",state:options.unknownStop?"root_exited":"stopped",treeControl:"process_group",boundaryEvidence:{launchDigest:"a".repeat(64),proof:{contract:"test"}},...(!options.unknownStop?{stopProof:{kind:"verified-tree-stop" as const,sourceId:"stop-source",identityDigest:"b".repeat(64),contractId:"test-contract"}}:{})};
  const stop:ProcessStopResult={stopped:!options.unknownStop,treeStopped:!options.unknownStop,records:[record]};
  const runtime:PreparedNativeRuntime={context,registry:new ManagedProcessRegistry({journal:{save(){}},context:()=>context}),spawn(){throw new Error("fixture client must not spawn");},async closeAndWait(){closes++;return stop;}};
  let receipt:NativeRevertMutationReceipt|undefined;
  const journal:NativeRevertMutationJournal={async claim(){return "claimed";},async get(){return{mutation,...(receipt?{receipt}:{})};},async record(_mutation,value){receipt=value;}};
  let handlers:AppServerClientHandlers|undefined;
  const port=new HostManagedNativeRevertPort({runtime:{},journal,contextFor:()=>context,assertCurrent(){assertions++;if(options.deniedAtRpc&&assertions>=4)throw new Error("REVOKED_AT_RPC");},nativeState:()=>({quiescent:!options.nativeRunning,pendingRequest:Boolean(options.nativeRunning)}),
    inspectExecution:()=>({sourceId:"exact-original-process-stop",quiescent:!options.unknownStop,pendingRequest:Boolean(options.unknownStop)}),codex:{executable:"/trusted/codex"},claude:{helperPath:"/trusted/native-revert-helper.js"},
    prepareRuntime:async()=>{preparations++;return runtime;},clientFactory:(nextHandlers,_runtime,beforeRequest)=>{
      handlers=nextHandlers;
      return {async start(){beforeRequest("initialize",{});},async request<T>(method:string,params:JsonObject={}){beforeRequest(method,params);calls.push({method,params});return {thread:{id:"thread",turns:[{id:"t1",status:"completed",items:[]}]}} as T;},notify(){},respond(){return true;},respondError(id,code,message){rejects.push({id,code,message});return true;},close(){},async closeAndWait(){return stop;}} satisfies AppServerClient;
    }});
  return {port,calls,rejects,journal,setReceipt(value:NativeRevertMutationReceipt){receipt=value;},get handlers(){return handlers!;},get preparations(){return preparations;},get assertions(){return assertions;},get closes(){return closes;}};
}
describe("managed native local-history port",()=>{
  it("performs exact read-only Codex thread/read and proves its helper stop",async()=>{
    const f=fixture(),history=await f.port.read(handle);
    expect(f.calls).toEqual([{method:"thread/read",params:{threadId:"thread",includeTurns:true}}]);
    expect(history).toMatchObject({nativeSessionId:"thread",verifiedVersion:"native-v1",quiescent:true,pendingRequest:false,entries:[{id:"t1"}]});
    expect(f.closes).toBe(1);f.handlers.onRequest({id:"inbound",method:"turn/start",params:{}});expect(f.rejects).toMatchObject([{id:"inbound",code:-32601}]);
  });
  it("sends the immutable actual rollback count without any turn/start or resume",async()=>{
    const f=fixture(),receipt=await f.port.execute(mutation);
    expect(f.calls).toEqual([{method:"thread/rollback",params:{threadId:"thread",numTurns:1}}]);
    expect(receipt).toMatchObject({state:"completed",requestId:"request",requestDigest:"request-digest",quiescent:true});
  });
  it("checks authorization at actual RPC write after asynchronous preparation",async()=>{
    const f=fixture({deniedAtRpc:true});
    await expect(f.port.execute(mutation)).rejects.toThrow("REVOKED_AT_RPC");expect(f.calls).toHaveLength(0);expect(f.closes).toBe(1);
  });
  it("retains actual helper identity when root exit cannot prove descendant stop",async()=>{
    const f=fixture({unknownStop:true});
    await expect(f.port.read(handle)).rejects.toMatchObject({code:"NATIVE_HELPER_STOP_UNKNOWN",producerFailure:{producerStopped:false,helper:{processId:"original-process",launchDigest:"a".repeat(64)}}});
  });
  it("does not mistake a stopped history helper for stopped original native producers",async()=>{
    const f=fixture({nativeRunning:true});expect(await f.port.read(handle)).toMatchObject({quiescent:false,pendingRequest:true});
  });
  it("queries only original persisted execution and receipt, including lost Claude fork responses",async()=>{
    const f=fixture(),claudeMutation={...mutation,originalHandle:{...handle,provider:"claude" as const},command:{method:"forkSession" as const,sessionId:"thread",upToMessageId:"m1"}};
    const journal:NativeRevertMutationJournal={...f.journal,async get(){return{mutation:claudeMutation};}};
    const port=new HostManagedNativeRevertPort({runtime:{},journal,contextFor:()=>context,assertCurrent(){throw new Error("query must not launch");},nativeState:()=>({quiescent:true,pendingRequest:false}),inspectExecution:()=>({sourceId:"original-stop",quiescent:true,pendingRequest:false}),codex:{executable:"/trusted/codex"}});
    expect(await port.query(claudeMutation)).toMatchObject({state:"unknown",requestId:"request",quiescent:true,pendingRequest:false});expect(f.preparations).toBe(0);
  });
  it("refuses Claude newConversation without inventing a native session or calling the SDK",async()=>{
    const f=fixture();expect(f.port.supportsTransition("claude","workspaceRestore")).toBe(false);
    await expect(f.port.execute({...mutation,originalHandle:{...handle,provider:"claude"},command:{method:"newConversation",provider:"claude"}})).rejects.toThrow("UNSUPPORTED");expect(f.preparations).toBe(0);
  });
  it("remains lazy and fail closed when the production native boundary refuses",async()=>{
    const f=fixture();let launched=false;
    const port=new HostManagedNativeRevertPort({runtime:{executionBoundary:async()=>({ready:false,code:"C0_UNAVAILABLE",summary:{}})},journal:f.journal,contextFor:()=>context,assertCurrent(){},nativeState:()=>({quiescent:true,pendingRequest:false}),inspectExecution:()=>({sourceId:"none",quiescent:false,pendingRequest:true}),codex:{executable:"/trusted/codex"},clientFactory(){launched=true;throw new Error("must not run");}});
    expect(launched).toBe(false);await expect(port.read(handle)).rejects.toThrow("C0_UNAVAILABLE");expect(launched).toBe(false);
  });
  it("parses only complete Codex Turn boundaries and preserves semantic Claude content across remapped UUIDs",()=>{
    expect(()=>parseCodexRevertHistory({thread:{id:"thread",turns:[{id:"t1",status:"inProgress",items:[]}]}},handle)).toThrow("BOUNDARY");
    expect(()=>parseCodexRevertHistory({thread:{id:"other",turns:[]}},handle)).toThrow("INVALID");
    const row={type:"assistant",uuid:"old",session_id:"source",message:{content:[{type:"text",text:"actual"}]},parent_tool_use_id:null,parent_agent_id:null};
    const source=parseClaudeRevertHistory({schema:1,sessionId:"source",messages:[row]},{...handle,provider:"claude",nativeSessionId:"source"});
    const fork=parseClaudeRevertHistory({schema:1,sessionId:"fork",messages:[{...row,uuid:"new",session_id:"fork"}]},{...handle,provider:"claude",nativeSessionId:"fork"});
    expect(source[0]!.digest).toBe(fork[0]!.digest);expect(source[0]!.id).not.toBe(fork[0]!.id);
  });
});

describe("controlled Claude SDK history helper",()=>{
  function sdk(){const calls:unknown[]=[];const value:ClaudeNativeHistorySdk={async getSessionInfo(sessionId,options){calls.push(["info",sessionId,options]);return{sessionId};},async getSessionMessages(sessionId,options){calls.push(["messages",sessionId,options]);return[{type:"assistant",uuid:"message-real",session_id:sessionId,message:{content:"kept"},parent_tool_use_id:null,parent_agent_id:null}];},async forkSession(sessionId,options){calls.push(["fork",sessionId,options]);return{sessionId:"actual-fork"};}};return{value,calls};}
  it("uses local history APIs and forkSession with exact inclusive message UUID",async()=>{
    const f=sdk();expect(await runNativeRevertHelper({schema:1,method:"fork",sessionId:"source",dir:"/workspace",upToMessageId:"message-real"},f.value)).toEqual({schema:1,sessionId:"actual-fork"});
    expect(f.calls.at(-1)).toEqual(["fork","source",{dir:"/workspace",upToMessageId:"message-real"}]);
    expect(f.calls[1]).toEqual(["messages","source",{dir:"/workspace",includeSystemMessages:true,limit:10001}]);
  });
  it("does not fork a missing, guessed or ambiguous message",async()=>{
    const f=sdk();await expect(runNativeRevertHelper({schema:1,method:"fork",sessionId:"source",dir:"/workspace",upToMessageId:"ui-item-id"},f.value)).rejects.toThrow("MESSAGE_NOT_FOUND");expect(f.calls.some((call)=>(call as unknown[])[0]==="fork")).toBe(false);
  });
  it("distinguishes a missing native session from an existing empty conversation",async()=>{
    const f=sdk();f.value.getSessionInfo=async()=>undefined;
    await expect(runNativeRevertHelper({schema:1,method:"read",sessionId:"missing",dir:"/workspace"},f.value)).rejects.toThrow("SESSION_NOT_FOUND");
    expect(f.calls).toHaveLength(0);
  });
});

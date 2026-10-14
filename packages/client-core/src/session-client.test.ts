import {describe,expect,it,vi} from "vitest";
import {SESSION_CATALOG_CAPABILITY,type SessionSummaryV2} from "@flyx/mvp-protocol";
import {SessionClient,type SessionClientPort} from "./session-client.js";

const summary=(sessionId="session-one"):SessionSummaryV2=>({sessionId,workspaceId:"workspace-one",providerInstanceId:"instance-claude",provider:"claude",title:"One",status:"active",activityState:"idle",headSequence:1,revision:1,residency:"unloaded",nativeSessionAvailable:false,createdAt:"2026-10-15T00:00:00Z",updatedAt:"2026-10-15T00:00:00Z"});
function fixture(response:unknown,enabled=true){
  const request=vi.fn(async(_method:string,_payload:unknown)=>response);
  const command=vi.fn(async(_method:string,_payload:unknown,_id?:string)=>response);
  const supportsCapability=vi.fn((name:string)=>enabled&&name===SESSION_CATALOG_CAPABILITY);
  const port:SessionClientPort={supportsCapability,request:<T>(method:string,payload?:unknown)=>request(method,payload) as Promise<T>,command:<T>(method:string,payload?:unknown,id?:string)=>command(method,payload,id) as Promise<T>};
  return {client:new SessionClient(port,{commandId:()=>"generated-command"}),request,command,supportsCapability};
}
const mutation=(session=summary(),commandId="command-one",state="completed")=>({session,receipt:{commandId,targetSessionId:session.sessionId,state}});

describe("typed Session client",()=>{
  it("requires the authenticated capability before invoking a public read or durable write",async()=>{
    const f=fixture({},false);
    await expect(f.client.list()).rejects.toMatchObject({code:"CAPABILITY_UNSUPPORTED"});
    await expect(f.client.createNew({workspaceId:"workspace-one",providerInstanceId:"instance-claude"})).rejects.toMatchObject({code:"CAPABILITY_UNSUPPORTED"});
    expect(f.request).not.toHaveBeenCalled();expect(f.command).not.toHaveBeenCalled();
  });
  it("creates a Host-scoped command through the durable public port without current Session inference",async()=>{
    const f=fixture(mutation(summary("new-session"),"generated-command"));
    const response=await f.client.createNew({workspaceId:"workspace-one",providerInstanceId:"instance-claude",title:"Fresh"});
    expect(response.session.sessionId).toBe("new-session");
    expect(f.command).toHaveBeenCalledWith("session.createNew",{workspaceId:"workspace-one",providerInstanceId:"instance-claude",title:"Fresh"},"generated-command");
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["accepted","completed","failed","cancelled","outcome_unknown"])("preserves the persisted %s receipt independently of Session status",async(state)=>{
    const f=fixture(mutation(summary(),"command-one",state));
    const result=await f.client.closeRuntime({sessionId:"session-one",expectedRevision:1},"command-one");
    expect(result.receipt.state).toBe(state);expect(result.session.status).toBe("active");
  });
  it.each([
    {receipt:{commandId:"foreign-command",targetSessionId:"session-one",state:"completed"}},
    {receipt:{commandId:"command-one",targetSessionId:"foreign-session",state:"completed"}},
    {receipt:{commandId:"command-one",targetSessionId:"session-one",state:"active"}},
    {receipt:undefined},
  ])("rejects missing, changed and invalid command receipt identity",async(change)=>{
    const f=fixture({...mutation(),...change});
    await expect(f.client.rename({sessionId:"session-one",expectedRevision:1,title:"New"},"command-one")).rejects.toMatchObject({code:"INVALID_RPC_RESPONSE"});
  });
  it("validates the actual create binding and explicit target in every mutation",async()=>{
    const wrongCreate=fixture(mutation({...summary(),providerInstanceId:"instance-codex"}));
    await expect(wrongCreate.client.createNew({workspaceId:"workspace-one",providerInstanceId:"instance-claude"},"command-one")).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
    const foreign=fixture(mutation(summary("foreign-session")));
    await expect(foreign.client.archive({sessionId:"session-one",expectedRevision:1},"command-one")).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
  });
  it("rejects a snapshot or active Turn belonging to another Session",async()=>{
    const f=fixture({session:summary("foreign-session"),pendingApprovals:[]});
    await expect(f.client.getSnapshot({sessionId:"session-one"})).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
    f.request.mockResolvedValue({session:summary(),pendingApprovals:[],activeTurn:{id:"turn",sessionId:"foreign-session",commandId:"turn-command",status:"running",prompt:"hello"}});
    await expect(f.client.getSnapshot({sessionId:"session-one"})).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
  });
  it("enforces the bounded workspace/archive/cursor directory scope",async()=>{
    const f=fixture({sessions:[summary()]});
    expect((await f.client.list({workspaceId:"workspace-one",limit:1})).sessions).toHaveLength(1);
    f.request.mockResolvedValue({sessions:[summary(),summary()]});
    await expect(f.client.list()).rejects.toMatchObject({code:"INVALID_RPC_RESPONSE"});
    f.request.mockResolvedValue({sessions:[{...summary(),status:"archived"}]});
    await expect(f.client.list({includeArchived:false})).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
    f.request.mockResolvedValue({sessions:[summary()],nextSessionId:"unrelated"});
    await expect(f.client.list()).rejects.toMatchObject({code:"INVALID_RPC_RESPONSE"});
  });
  it("binds execution responses to the requested Session and generated command identity",async()=>{
    const f=fixture({sessionId:"session-one",turnId:"turn-one",status:"accepted",receipt:{commandId:"generated-command",targetSessionId:"session-one",state:"accepted"}});
    expect((await f.client.startTurn({sessionId:"session-one",prompt:"hello",clientMessageId:"message-one"})).receipt.state).toBe("accepted");
    expect(f.command).toHaveBeenCalledWith("session.startTurn",{sessionId:"session-one",prompt:"hello",clientMessageId:"message-one"},"generated-command");
    f.command.mockResolvedValue({sessionId:"foreign-session",status:"accepted",receipt:{commandId:"command-one",targetSessionId:"foreign-session",state:"accepted"}});
    await expect(f.client.interrupt({sessionId:"session-one"},"command-one")).rejects.toMatchObject({code:"SESSION_TARGET_MISMATCH"});
  });
});

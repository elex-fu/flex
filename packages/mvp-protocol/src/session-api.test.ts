import {describe,expect,it} from "vitest";
import {SessionSchema} from "./index.js";
import {CreateSessionV2Schema,SessionSummaryV2Schema,SessionNativeHandleSchema,StartTurnV2Schema} from "./session-api.js";
describe("explicit Session catalog protocol",()=>{
  it("keeps arbitrary client filesystem paths out of registration and writes",()=>{
    expect(CreateSessionV2Schema.safeParse({workspaceId:"registered",providerInstanceId:"configured",cwd:"/client/supplied"}).success).toBe(false);
    expect(StartTurnV2Schema.parse({sessionId:"explicit",prompt:"hello",clientMessageId:"message"}).sessionId).toBe("explicit");
    expect(StartTurnV2Schema.safeParse({prompt:"missing target"}).success).toBe(false);
  });
  it("uses real workspace IDs in V2 while preserving the legacy literal default contract",()=>{
    const session={sessionId:"session",workspaceId:"actual-workspace",providerInstanceId:"provider",provider:"codex",title:"Title",status:"active",activityState:"idle",headSequence:0,revision:0,residency:"unloaded",nativeSessionAvailable:false,createdAt:"created",updatedAt:"updated"};
    expect(SessionSummaryV2Schema.parse(session).workspaceId).toBe("actual-workspace");expect(SessionSchema.safeParse({...session,id:"session"}).success).toBe(false);expect(SessionSchema.safeParse({...session,id:"session",workspaceId:"default"}).success).toBe(true);
    expect(SessionSummaryV2Schema.safeParse({...session,nativeHandle:{nativeSessionId:"private"}}).success).toBe(false);
  });
  it("retains typed private native ownership rather than accepting unscoped handles",()=>{
    expect(SessionNativeHandleSchema.safeParse({nativeSessionId:"thread"}).success).toBe(false);expect(SessionNativeHandleSchema.parse({v:1,provider:"claude",providerInstanceId:"instance",workspaceId:"workspace",nativeSessionId:"conversation",provenance:"legacy"}).provider).toBe("claude");
  });
});

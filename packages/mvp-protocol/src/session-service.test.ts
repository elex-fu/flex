import {describe,expect,it} from "vitest";
import {CatalogMutationResponseSchema,CatalogReceiptSchema,SessionExecutionResponseV2Schema} from "./session-service.js";

const session={sessionId:"session-one",workspaceId:"registered-workspace",providerInstanceId:"codex-one",provider:"codex",title:"One",status:"active",activityState:"idle",headSequence:4,revision:4,residency:"unloaded",nativeSessionAvailable:true,createdAt:"now",updatedAt:"now"};
describe("catalog service response contracts",()=>{
  it.each(["accepted","completed","failed","cancelled","outcome_unknown"])("carries the actual %s command state",(state)=>{
    const response={session,receipt:{commandId:"command-one",targetSessionId:"session-one",state}};
    expect(CatalogMutationResponseSchema.parse(response)).toEqual(response);
  });
  it("rejects foreign targets and private native/owner fields",()=>{
    expect(CatalogMutationResponseSchema.safeParse({session,receipt:{commandId:"c",targetSessionId:"other",state:"completed"}}).success).toBe(false);
    expect(CatalogMutationResponseSchema.safeParse({session:{...session,nativeHandle:{nativeSessionId:"private"}},receipt:{commandId:"c",targetSessionId:"session-one",state:"completed"}}).success).toBe(false);
    expect(CatalogReceiptSchema.safeParse({commandId:"c",targetSessionId:"session-one",state:"completed",ownerId:"private"}).success).toBe(false);
    expect(SessionExecutionResponseV2Schema.safeParse({sessionId:"session-one",status:"accepted",receipt:{commandId:"c",targetSessionId:"other",state:"accepted"}}).success).toBe(false);
  });
});

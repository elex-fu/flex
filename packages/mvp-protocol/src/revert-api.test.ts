import { expect,it } from "vitest";
import { CheckpointExecuteRevertSchema,CheckpointWorkspaceRestoreSchema,CheckpointResumeVerifiedSchema } from "./revert-api.js";
it("accepts controlled IDs and rejects missing confirmation and arbitrary restore paths/refs",()=>{
 const request={sessionId:"session",commandId:"command",planId:"plan",expectedSessionRevision:3,confirmation:true};
 expect(CheckpointExecuteRevertSchema.parse(request)).toEqual(request);expect(CheckpointWorkspaceRestoreSchema.parse(request)).toEqual(request);
 expect(CheckpointExecuteRevertSchema.safeParse({...request,confirmation:false}).success).toBe(false);
 expect(CheckpointExecuteRevertSchema.safeParse({...request,ref:"HEAD",workspacePath:"/tmp/repo"}).success).toBe(false);
 expect(CheckpointResumeVerifiedSchema.safeParse({sessionId:"session",operationId:"operation",commandId:"command",evidenceId:"evidence",expectedSessionRevision:3,confirmation:true,leaseId:"client-proof"}).success).toBe(false);
});

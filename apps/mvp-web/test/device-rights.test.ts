import assert from "node:assert/strict";
import test from "node:test";
import { currentApprovalWrite } from "../src/device-rights.js";
const directory={currentDeviceId:"device",devices:[{id:"device",hostId:"host-a",scopes:["session:read","approval:write"]}]};
test("response rights cannot come from another Host, a revoked row, or unresolved metadata",()=>{
  assert.equal(currentApprovalWrite(directory,"host-a"),true);assert.equal(currentApprovalWrite(directory,"host-b"),false);
  assert.equal(currentApprovalWrite({...directory,devices:[{...directory.devices[0],revokedAt:"2026-10-15"}]},"host-a"),false);
  assert.equal(currentApprovalWrite({payloadRef:{}},"host-a"),false);assert.equal(currentApprovalWrite({...directory,devices:[{id:"device",hostId:"host-a",scopes:["session:read"]}]},"host-a"),false);
});

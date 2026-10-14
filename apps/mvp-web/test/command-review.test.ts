import assert from "node:assert/strict";
import test from "node:test";
import type { PendingCommand } from "@flyx/client-core";
import { canSendSavedCommand, needsCommandReview } from "../src/command-review.js";
const command:PendingCommand={commandId:"command",hostId:"host",method:"session.startTurn",payloadHash:"hash",payload:{prompt:"task"},createdAt:"2026-10-15T00:00:00.000Z",state:"queued",dispatchState:"not_dispatched"};
test("only persisted not-dispatched mutations expose an explicit send action",()=>{
  assert.equal(canSendSavedCommand(command),true);
  for(const value of [{...command,dispatchState:undefined},{...command,dispatchState:"possibly_dispatched"},{...command,state:"accepted"},{...command,outcomeUnknown:true},{...command,method:"access.revokeSelf"}]) assert.equal(canSendSavedCommand(value as PendingCommand),false);
});
test("accepted, unknown and failed commands retain their independent review entry",()=>{
  assert.equal(needsCommandReview({...command,state:"accepted"}),true);assert.equal(needsCommandReview({...command,state:"receipt_unknown",outcomeUnknown:true}),true);assert.equal(needsCommandReview({...command,state:"terminal",error:{code:"FORBIDDEN",message:"Denied"}}),true);assert.equal(needsCommandReview({...command,state:"terminal"}),false);
});

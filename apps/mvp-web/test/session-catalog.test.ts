import assert from "node:assert/strict";
import test from "node:test";
import { loadWebSessionPage, normalizeWebSnapshot, parseWebSessionPage } from "../src/session-catalog.js";
const session={sessionId:"explicit-session",workspaceId:"workspace",providerInstanceId:"provider-instance",provider:"codex",title:"Task",status:"active",activityState:"idle",headSequence:1,revision:1,residency:"unloaded",nativeSessionAvailable:false,createdAt:"2026-10-15",updatedAt:"2026-10-15"};
test("strict Catalog DTOs map public sessionId to the actual selectable Session",async()=>{
  let payload:unknown;const page=await loadWebSessionPage(async(method,value)=>{assert.equal(method,"session.list");payload=value;return {sessions:[session],nextSessionId:"next"};});
  assert.deepEqual(payload,{limit:50,includeArchived:false});assert.equal(page.sessions[0]?.id,"explicit-session");assert.equal(page.nextSessionId,"next");
  assert.throws(()=>parseWebSessionPage({sessions:[{...session,nativeSessionId:"private"}]}));
});
test("V2 snapshots use the frozen public DTO and cannot leak private native handles",()=>{
  const result=normalizeWebSnapshot({session,activeTurn:{id:"turn",sessionId:"explicit-session",commandId:"command",status:"running",prompt:"task",generation:1},pendingApprovals:[]});assert.equal(result.session.id,"explicit-session");assert.equal(result.session.provider,"codex");assert.equal(result.activeTurn?.id,"turn");
  assert.throws(()=>normalizeWebSnapshot({session:{...session,nativeSessionId:"private"},pendingApprovals:[]}));
});

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryClientStore, type ClientDraft, type DraftCommandOptions, type DraftKey, type PendingCommand } from "@flyx/client-core";
import { WebDraftController, type DraftCommandClient } from "../src/draft-controller.js";
function deferred<T = void>() { let resolve!: (value:T)=>void; const promise = new Promise<T>((yes) => {resolve=yes;}); return {promise,resolve}; }
const key = {hostId:"host-a",sessionId:"session-a"};
function fixture(store = new MemoryClientStore(), gate?:Promise<void>) {
  let next = 0, sends = 0; const payloads:unknown[] = [];
  const client:DraftCommandClient = {store,async commandFromDraft<T>(_method:string,payload:unknown,draftKey:DraftKey,options:DraftCommandOptions) {
    payloads.push(payload); await gate;
    const command:PendingCommand = {commandId:"command-"+(++next),hostId:draftKey.hostId,method:"session.startTurn",payloadHash:"hash",payload,createdAt:new Date().toISOString(),state:"queued",dispatchState:"not_dispatched"};
    await store.putCommandAndClearDraft(command,draftKey,options.draftUpdatedAt); options.onPersisted?.(command); sends++; return {turnId:"turn-a"} as T;
  }};
  let uuid = 0; const controller = new WebDraftController(() => "message-"+(++uuid));
  return {store,client,controller,payloads,sends:()=>sends};
}
test("failed draft storage keeps editable text and prevents command handoff",async () => {
  class Store extends MemoryClientStore { override async putDraft(_value:ClientDraft):Promise<void> {throw new Error("disk full");} }
  const f = fixture(new Store()); await f.controller.select(key,f.client); f.controller.edit("keep this task"); await f.controller.flush();
  await assert.rejects(f.controller.submit(true),/disk full/); assert.equal(f.controller.getState().text,"keep this task"); assert.equal(f.sends(),0); assert.equal(f.payloads.length,0);
});
test("failed atomic handoff preserves the durable draft and input before any send",async () => {
  class Store extends MemoryClientStore { override async putCommandAndClearDraft():Promise<void> {throw new Error("transaction rolled back");} }
  const f = fixture(new Store()); await f.controller.select(key,f.client); f.controller.edit("persist first"); await f.controller.flush();
  await assert.rejects(f.controller.submit(true),/rolled back/); assert.equal(f.controller.getState().text,"persist first"); assert.equal((await f.store.getDraft(key))?.text,"persist first"); assert.equal(f.sends(),0); assert.deepEqual(await f.store.listCommands(key.hostId),[]);
});
test("late draft reads cannot overwrite a faster local edit",async () => {
  const entered = deferred(), old = deferred<ClientDraft | undefined>();
  class Store extends MemoryClientStore { reads=0; override async getDraft(value:DraftKey) {if (++this.reads === 1) {entered.resolve();return old.promise;} return super.getDraft(value);} }
  const f = fixture(new Store()); const loading = f.controller.select(key,f.client); await entered.promise; f.controller.edit("newer edit"); await f.controller.flush();
  old.resolve({...key,text:"old disk value",updatedAt:1,clientMessageId:"old-message"}); await loading;
  assert.equal(f.controller.getState().text,"newer edit"); assert.equal((await f.store.getDraft(key))?.text,"newer edit");
});
test("new edits during atomic handoff retain their own durable draft and message identity",async () => {
  const gate = deferred(); const f = fixture(new MemoryClientStore(),gate.promise); await f.controller.select(key,f.client); f.controller.edit("original task"); await f.controller.flush();
  const firstId = (await f.store.getDraft(key))!.clientMessageId; const submitting = f.controller.submit(true);
  while (f.payloads.length === 0) await new Promise<void>((done) => setImmediate(done));
  f.controller.edit("new task typed while saving"); await f.controller.flush(); const newDraft = (await f.store.getDraft(key))!;
  assert.notEqual(newDraft.clientMessageId,firstId); gate.resolve(); await submitting;
  assert.equal(f.controller.getState().text,newDraft.text); assert.equal((await f.store.getDraft(key))?.text,newDraft.text);
  assert.deepEqual(f.payloads[0],{prompt:"original task",clientMessageId:firstId,sessionId:key.sessionId});
});
test("onPersisted clears only the original Session buffer after a selection change",async () => {
  const gate = deferred(); const f = fixture(new MemoryClientStore(),gate.promise); await f.controller.select(key,f.client); f.controller.edit("session A"); await f.controller.flush();
  const sending = f.controller.submit(false); while (f.payloads.length === 0) await new Promise<void>((done) => setImmediate(done));
  const second = {...key,sessionId:"session-b"}; await f.controller.select(second,f.client); f.controller.edit("session B"); await f.controller.flush(); gate.resolve(); await sending;
  assert.equal(f.controller.getState().text,"session B"); assert.equal((await f.store.getDraft(second))?.text,"session B");
  await f.controller.select(key,f.client); assert.equal(f.controller.getState().text,""); assert.equal((f.payloads[0] as Record<string,unknown>).sessionId,undefined);
});
test("switching Host while a local save is pending prevents old selection dispatch",async () => {
  const write = deferred(), entered = deferred();
  class Store extends MemoryClientStore { override async putDraft(value:ClientDraft) {entered.resolve();await write.promise;await super.putDraft(value);} }
  const f = fixture(new Store()); await f.controller.select(key,f.client); f.controller.edit("host A input"); const submitting = f.controller.submit(true); await entered.promise;
  await f.controller.select({hostId:"host-b",sessionId:"session-b"},fixture().client); write.resolve(); await assert.rejects(submitting,/DRAFT_SELECTION_CHANGED/); assert.equal(f.sends(),0); assert.equal((await f.store.getDraft(key))?.text,"host A input");
});
test("local forget waits storage writes, fences new writes and preserves another Host",async () => {
  const write = deferred(), entered = deferred();
  class Store extends MemoryClientStore { override async putDraft(value:ClientDraft) {entered.resolve();await write.promise;await super.putDraft(value);} }
  const f = fixture(new Store()); await f.controller.select(key,f.client); f.controller.edit("about to be forgotten"); await entered.promise;
  let purges = 0; const forgetting = f.controller.forgetHost(key.hostId,async () => {purges++;await f.store.forgetLocalHost(key.hostId);});
  f.controller.edit("must not recreate deleted data"); assert.equal(purges,0);
  const other = fixture(); await f.controller.select({hostId:"host-b",sessionId:"session-b"},other.client); f.controller.edit("host B retained"); write.resolve(); await forgetting; await f.controller.flush();
  assert.equal(purges,1); assert.equal(await f.store.getDraft(key),undefined); assert.equal(f.controller.getState().text,"host B retained"); assert.equal((await other.store.getDraft({hostId:"host-b",sessionId:"session-b"}))?.text,"host B retained");
});
test("failed local deletion preserves the buffer and permits later edits",async () => {
  const f = fixture(); await f.controller.select(key,f.client); f.controller.edit("keep on failed deletion"); await f.controller.flush();
  await assert.rejects(f.controller.forgetHost(key.hostId,async () => {throw new Error("delete failed");}),/delete failed/);
  assert.equal(f.controller.getState().text,"keep on failed deletion"); f.controller.edit("still editable"); await f.controller.flush(); assert.equal((await f.store.getDraft(key))?.text,"still editable");
});

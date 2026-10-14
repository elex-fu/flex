import assert from "node:assert/strict";
import test from "node:test";
import { SelectedWebLoader, WebSelectionFence } from "../src/selection-loader.js";
function deferred<T>() {let resolve!:(value:T)=>void, reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const selection = {hostId:"host-a",sessionId:"session-a",transportGeneration:1};
test("late Host/session content cannot replace the current selection",async()=>{
  const fence=new WebSelectionFence(), loader=new SelectedWebLoader<string>(fence), old=deferred<string>();fence.select(selection);const pending=loader.load(()=>old.promise);
  fence.select({...selection,hostId:"host-b",sessionId:"session-b"});loader.reset();await loader.load(async()=>"Host B content");old.resolve("private Host A content");await pending;
  assert.deepEqual(loader.getState(),{status:"ready",value:"Host B content"});
});
test("forget or transport replacement invalidates a late failure without erasing current data",async()=>{
  const fence=new WebSelectionFence(), loader=new SelectedWebLoader<string>(fence), old=deferred<string>();fence.select(selection);const pending=loader.load(()=>old.promise);
  fence.invalidate();fence.select({...selection,transportGeneration:2});await loader.load(async()=>"current data");old.reject(new Error("old transport error"));await pending;assert.deepEqual(loader.getState(),{status:"ready",value:"current data"});
});
test("a failed explicit read preserves its preview and reports loading/error honestly",async()=>{
  const fence=new WebSelectionFence(), loader=new SelectedWebLoader<string>(fence);fence.select(selection);await loader.load(async()=>"preview");const statuses:string[]=[];const off=loader.observe(state=>statuses.push(state.status));
  await loader.load(async()=>{throw new Error("content pruned");});off();assert.deepEqual(statuses,["ready","loading","error"]);assert.deepEqual(loader.getState(),{status:"error",value:"preview",error:"content pruned"});
});

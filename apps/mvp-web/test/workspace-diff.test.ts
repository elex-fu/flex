import assert from "node:assert/strict";
import test from "node:test";
import { expandWorkspaceDiff, parseWorkspaceDiff } from "../src/workspace-diff.js";
const ref={ref:"cnt_"+"a".repeat(32),bytes:100,sha256:"b".repeat(64),format:"application/json"};
test("generic bounded payloadRef remains unresolved until an explicit JSON read",async()=>{
  const value=parseWorkspaceDiff({boundedContent:{truncated:true,requiresUpgrade:false,originalBytes:100},payloadRef:ref});assert.equal(value.dirty,undefined);assert.equal(value.diff,"");assert.deepEqual(value.payloadRef,ref);
  let reads=0;const loaded=await expandWorkspaceDiff(value,async reference=>{reads++;assert.deepEqual(reference,ref);return JSON.stringify({dirty:true,files:[{path:"file.ts"}],diff:"actual diff",truncated:false});});assert.equal(reads,1);assert.equal(loaded.diff,"actual diff");assert.equal(loaded.payloadLoaded,true);
});
test("loading a diffRef cannot erase a Git-generated truncation warning",async()=>{
  const value=parseWorkspaceDiff({dirty:true,files:[],diff:"preview",diffRef:{...ref,format:"text/plain"},diffTruncated:true,truncated:true,boundedContent:{truncated:true,requiresUpgrade:false,originalBytes:100}});
  const loaded=await expandWorkspaceDiff(value,async()=>"stored diff prefix");assert.equal(loaded.diff,"stored diff prefix");assert.equal(loaded.truncated,true);assert.equal(loaded.diffLoaded,true);assert.equal(loaded.diffRef,undefined);
});
test("an upgrade-only bounded response does not masquerade as a complete clean Diff",()=>{
  const value=parseWorkspaceDiff({boundedContent:{truncated:true,requiresUpgrade:true,originalBytes:100}});assert.equal(value.dirty,undefined);assert.equal(value.requiresUpgrade,true);assert.equal(value.bounded,true);
  assert.throws(()=>parseWorkspaceDiff({files:[],dirty:false}),/DIFF_RESPONSE_INVALID/);
});

test("a verified field reference can complete a transport preview without inventing a Git truncation",async()=>{
  const value=parseWorkspaceDiff({dirty:true,files:[],diff:"preview",diffRef:{...ref,format:"text/plain"},diffTruncated:true,truncated:false,boundedContent:{truncated:true,requiresUpgrade:false,originalBytes:100}});
  assert.equal(value.bounded,true);const loaded=await expandWorkspaceDiff(value,async()=>"verified original diff");assert.equal(loaded.diffLoaded,true);assert.equal(loaded.truncated,false);assert.equal(loaded.diff,"verified original diff");
});

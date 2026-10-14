import assert from "node:assert/strict";
import test from "node:test";
import { HostRuntimeRegistry, MemoryClientStore, type ClientState, type HostProfile } from "@flyx/client-core";
import { WebHostRuntimes } from "../src/host-runtimes.js";
import { StoredWebBootstrapPreference, WEB_BOOTSTRAP_PREFERENCE_KEY } from "../src/bootstrap-preference.js";
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
function storage() {const values=new Map<string,string>();return {values,fail:false,getItem(key:string){return values.get(key) ?? null;},setItem(key:string,value:string){if(this.fail) throw new Error("storage denied");values.set(key,value);},removeItem(key:string){values.delete(key);}};}
const profile:HostProfile={hostId:"host-a",label:"Host A",hostPublicKey:"public",signingPublicKey:"signing",fingerprint:`sha256:${"a".repeat(64)}`,endpoints:[]};
class CookieRuntime {
  readonly store:MemoryClientStore; readonly cookieExists=true; activations=0; stops=0; pairs=0; private started=false;
  private state:ClientState={connection:"idle",sync:"unknown",transportGeneration:0,pairingRequired:false,profile};
  constructor(store=new MemoryClientStore(),private gate?:Promise<void>) {this.store=store;}
  bindHostOwner(hostId:string){assert.equal(hostId,"host-a");}
  getState(){return this.state;}
  onState(handler:(state:ClientState)=>void){handler(this.state);return ()=>{};}
  async start(){if(this.started)return;this.started=true;this.activations++;await this.gate;this.state={...this.state,connection:"online"};}
  stop(){this.stops++;this.started=false;}
  async pair(_input:string){this.pairs++;await this.start();}
}
test("persisted local forget prevents bootstrap on reload while the HttpOnly cookie still exists",async()=>{
  const disk=storage(), preference=new StoredWebBootstrapPreference(()=>disk), old=new CookieRuntime();
  await old.store.putProfile(profile);await old.store.putDraft({hostId:"host-a",sessionId:"s1",text:"draft",updatedAt:1});
  const owners=new WebHostRuntimes(new HostRuntimeRegistry(()=>new CookieRuntime(old.store)),()=>old,preference);await owners.initialize();await owners.forgetLocalHost("host-a");
  assert.equal(disk.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY),"blocked");assert.equal(old.cookieExists,true);assert.equal(await old.store.getDraft({hostId:"host-a",sessionId:"s1"}),undefined);
  const reload=new CookieRuntime();const next=new WebHostRuntimes(new HostRuntimeRegistry(()=>new CookieRuntime()),()=>reload,new StoredWebBootstrapPreference(()=>disk));await next.initialize();await next.initialize();
  assert.equal(reload.activations,0);assert.equal(next.registry.desiredHost,undefined);
});
test("only explicit pairing restores bootstrap after an authenticated pinned Host is adopted",async()=>{
  const disk=storage();disk.setItem(WEB_BOOTSTRAP_PREFERENCE_KEY,"blocked");const candidates:CookieRuntime[]=[];
  const owners=new WebHostRuntimes(new HostRuntimeRegistry(()=>new CookieRuntime()),()=>{const value=new CookieRuntime();candidates.push(value);return value;},new StoredWebBootstrapPreference(()=>disk));
  await owners.initialize();assert.equal(candidates.length,0);await owners.pair("explicit pairing offer","browser");
  assert.equal(owners.registry.desiredHost,"host-a");assert.equal(candidates[0]?.pairs,1);assert.equal(disk.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY),null);
});
test("a failed durable bootstrap flag leaves local records intact and blocks further automatic startup",async()=>{
  const disk=storage(), runtime=new CookieRuntime();await runtime.store.putProfile(profile);await runtime.store.putDraft({hostId:"host-a",sessionId:"s1",text:"retain",updatedAt:1});
  const owners=new WebHostRuntimes(new HostRuntimeRegistry(()=>new CookieRuntime()),()=>runtime,new StoredWebBootstrapPreference(()=>disk));await owners.initialize();disk.fail=true;
  await assert.rejects(owners.forgetLocalHost("host-a"),/本地记录尚未删除/);assert.equal((await runtime.store.getDraft({hostId:"host-a",sessionId:"s1"}))?.text,"retain");assert.equal(owners.registry.peek("host-a"),runtime);
  await owners.initialize();assert.equal(runtime.activations,1);
});
test("late initialization cannot resurrect a forgotten pinned bootstrap owner",async()=>{
  const disk=storage(), gate=deferred(), runtime=new CookieRuntime(new MemoryClientStore(),gate.promise);const store=runtime.store;
  let created=0;const owners=new WebHostRuntimes(new HostRuntimeRegistry(()=>new CookieRuntime(store)),()=>created++ === 0 ? runtime : new CookieRuntime(store),new StoredWebBootstrapPreference(()=>disk));const starting=owners.initialize();
  await owners.forgetLocalHost("host-a");gate.resolve();await starting;assert.equal(owners.registry.peek("host-a"),undefined);assert.equal(owners.registry.desiredHost,undefined);assert.notEqual(owners.getCurrent(),runtime);
  const count=runtime.activations;await owners.initialize();assert.equal(runtime.activations,count);assert.equal(disk.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY),"blocked");
});

test("an explicit saved Host selection clears the opt-out through its owned authenticated runtime",async()=>{
  const disk=storage();disk.setItem(WEB_BOOTSTRAP_PREFERENCE_KEY,"blocked");const runtime=new CookieRuntime();const owners=new WebHostRuntimes(new HostRuntimeRegistry(()=>runtime),()=>new CookieRuntime(),new StoredWebBootstrapPreference(()=>disk));
  await owners.initialize();assert.equal(runtime.activations,0);await owners.setDesired("host-a");assert.equal(runtime.activations,1);assert.equal(owners.getCurrent(),runtime);assert.equal(disk.getItem(WEB_BOOTSTRAP_PREFERENCE_KEY),null);
});

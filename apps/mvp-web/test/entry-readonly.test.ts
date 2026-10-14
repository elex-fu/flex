import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlyxClient, HostRuntimeRegistry, MemoryClientStore, type ClientState } from "@flyx/client-core";
import { App } from "../src/app.js";
import { WebHostRuntimes } from "../src/host-runtimes.js";
class OfflineClient extends FlyxClient {
  starts=0;
  constructor() {super({store:new MemoryClientStore()});this.replica.begin("saved-session",1);}
  override getState():ClientState {return {connection:"closed",sync:"unknown",transportGeneration:1,pairingRequired:false,profile:{hostId:"host-a",label:"Saved Host",hostPublicKey:"public",signingPublicKey:"signing",fingerprint:`sha256:${"a".repeat(64)}`,endpoints:[]}};}
  override getProjectionMode(){return "canonical" as const;}
  override async start(){this.starts++;throw new Error("render must not start a runtime");}
}
test("the actual offline entry separates enabled local deletion from disabled server writes",()=>{
  const client=new OfflineClient();const owners=new WebHostRuntimes<FlyxClient>(new HostRuntimeRegistry<FlyxClient>(()=>client),()=>client);
  const html=renderToStaticMarkup(createElement(App,{runtimes:owners}));
  assert.match(html,/当前视图只读/);assert.match(html,/<button class="ghost">移除本地 Host<\/button>/);
  assert.match(html,/<button class="danger" disabled="">撤销本设备授权<\/button>/);assert.match(html,/<button class="primary" disabled="">发送任务<\/button>/);
  assert.equal(client.starts,0);
});

import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {SessionSchema,SessionSummaryV2Schema} from "@flyx/mvp-protocol";
import {createTestHostOwner} from "../lifecycle/host-owner.js";
import {openOwned} from "../storage/open-store.js";
import {SqliteStore} from "../storage/db.js";
import {FROZEN_V6_SCHEMA} from "../test-support/frozen-v6-schema.js";
import {CatalogStore,hashCatalogRequest} from "../storage/catalog-store.js";
import {applyCatalogMigration,legacyWorkspaceId,legacyProviderInstanceId} from "../storage/migrations/007-catalog.js";
import {WorkspaceRegistry} from "../workspace/workspace-registry.js";
import {ProviderInstanceRegistry} from "../provider/provider-instance-registry.js";
import {SessionRegistry,type RuntimeCloseReport,type SessionRuntimeContext} from "./session-registry.js";
import {LegacySessionFacade} from "./legacy-session-facade.js";

const roots:string[]=[];const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const clean:RuntimeCloseReport={closed:true,producerStopped:true,clean:true,state:"stopped"};
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise<void>((resolve)=>setImmediate(resolve));
class FakeRuntime {
  closeCalls=0;
  closeGate=deferred<RuntimeCloseReport>();
  constructor(readonly sessionId:string,readonly runtimeId:string){}
  closeAndWait=vi.fn(async()=>{this.closeCalls++;return this.closeGate.promise;});
  startTurn=vi.fn(async()=>({turnId:this.sessionId,status:"accepted" as const}));
  interrupt=vi.fn(async()=>({status:"accepted"}));
  respondApproval=vi.fn(async()=>({status:"accepted"}));
  subscribe=vi.fn(()=>()=>{});
}
async function fixture(factory?:(context:SessionRuntimeContext)=>Promise<FakeRuntime>|FakeRuntime) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"flyx-catalog-")));roots.push(root);
  const checkout=join(root,"checkout");mkdirSync(checkout);execFileSync("git",["init","--quiet",checkout]);
  const owner=createTestHostOwner();const store=openOwned({databasePath:":memory:",owner});cleanups.push(()=>{store.close();owner.release();});
  applyCatalogMigration(store.db);
  const catalog=new CatalogStore(store);cleanups.push(()=>catalog.dispose());
  const workspaces=new WorkspaceRegistry(catalog,{owner});await workspaces.registerLocal({workspaceId:"workspace-one",root:checkout});
  const providers=new ProviderInstanceRegistry(catalog);
  for(const provider of ["claude","codex"] as const)providers.registerLocal({providerInstanceId:`instance-${provider}`,provider,executable:process.execPath,policyCapabilities:["streamingText","workspaceWrite"]});
  const runtimeFactory=vi.fn(factory??((context)=>{const runtime=new FakeRuntime(context.session.sessionId,context.runtimeId);runtime.closeGate.resolve(clean);return runtime;}));
  const registry=new SessionRegistry(catalog,workspaces,providers,{owner,runtimeFactory});
  const create=(commandId:string,provider="claude")=>registry.createNew({authSubjectId:"primary-device",commandId},{workspaceId:"workspace-one",providerInstanceId:`instance-${provider}`,title:commandId}).summary;
  return {root,checkout,owner,store,catalog,workspaces,providers,registry,runtimeFactory,create};
}

describe("Session catalog and lazy runtime routing",()=>{
  it("creates two Providers on one writer with V2 receipts and independent events without loading history",async()=>{
    const f=await fixture();const first=f.create("first");const second=f.create("second","codex");
    expect(first.workspaceId).toBe("workspace-one");expect(first.provider).toBe("claude");expect(second.provider).toBe("codex");
    expect(SessionSummaryV2Schema.parse(first)).toEqual(first);
    expect(f.registry.list().sessions).toHaveLength(2);
    expect(f.registry.readEvents(first.sessionId).events.map((event)=>event.payload)).toEqual([{sessionId:first.sessionId,workspaceId:"workspace-one",providerInstanceId:"instance-claude",title:"first"}]);
    expect(f.registry.readEvents(second.sessionId).events[0]?.sessionId).toBe(second.sessionId);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    expect(f.create("first")).toEqual(first);
    expect(()=>f.create("first","codex")).toThrow("COMMAND_ID_REUSED");
    expect(f.store.getCommandReceipt("primary-device","first")).toMatchObject({requestFormatVersion:2,targetSessionId:first.sessionId,state:"completed"});
    const old=f.store.putCommandReceipt({authSubjectId:"legacy-device",commandId:"old",method:"session.createNew",requestHash:"legacy",state:"completed",response:first});
    expect(old.requestFormatVersion??1).toBe(1);
    expect(()=>f.registry.createNew({authSubjectId:"legacy-device",commandId:"old"},{workspaceId:"workspace-one",providerInstanceId:"instance-claude",title:"first"})).toThrow("COMMAND_ID_REUSED");
    expect(hashCatalogRequest("session.startTurn",{sessionId:first.sessionId,prompt:"same"},f.registry.requestContext(first.sessionId))).not.toBe(hashCatalogRequest("session.startTurn",{sessionId:second.sessionId,prompt:"same"},f.registry.requestContext(second.sessionId)));
  });
  it("keeps legacy session.create a pure default snapshot after newer Sessions and browser selections",async()=>{
    const f=await fixture();const first=f.create("default");f.catalog.setLegacyDefaultOnce(first.sessionId);
    const later=f.create("later","codex");const facade=new LegacySessionFacade(f.registry);
    const before=f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    expect(facade.create().session.id).toBe(first.sessionId);expect(facade.create().session.workspaceId).toBe("default");
    expect(SessionSchema.parse(facade.create().session).id).toBe(first.sessionId);
    f.registry.readSnapshot(later.sessionId);expect(facade.sessionId).toBe(first.sessionId);
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual(before);
    expect(f.runtimeFactory).not.toHaveBeenCalled();
    expect(()=>f.catalog.setLegacyDefaultOnce(later.sessionId)).toThrow("LEGACY_DEFAULT_CONFLICT");
  });
  it("subscribes to committed Session events without loading a runtime or delivering another Session's stream",async()=>{
    const f=await fixture();const first=f.create("first");const second=f.create("second","codex");f.catalog.setLegacyDefaultOnce(first.sessionId);const facade=new LegacySessionFacade(f.registry);
    const defaultEvents:unknown[]=[];const secondEvents:unknown[]=[];const unsubscribe=facade.subscribe((event)=>defaultEvents.push(event));f.registry.subscribe(second.sessionId,(event)=>secondEvents.push(event));
    f.registry.rename({authSubjectId:"primary-device",commandId:"rename-first"},{sessionId:first.sessionId,expectedRevision:first.revision,title:"Changed first"});
    expect(defaultEvents).toHaveLength(1);expect(secondEvents).toEqual([]);expect(f.runtimeFactory).not.toHaveBeenCalled();unsubscribe();
    f.registry.rename({authSubjectId:"primary-device",commandId:"rename-second"},{sessionId:second.sessionId,expectedRevision:second.revision,title:"Changed second"});expect(defaultEvents).toHaveLength(1);expect(secondEvents).toHaveLength(1);
  });
  it("deduplicates loads and waits for the exact close before another runtime starts",async()=>{
    const load=deferred<FakeRuntime>();const f=await fixture(()=>load.promise);const session=f.create("one");
    const one=f.registry.ensureLoaded(session.sessionId);const two=f.registry.ensureLoaded(session.sessionId);expect(one).toBe(two);
    await tick();expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
    const runtime=new FakeRuntime(session.sessionId,"runtime-one");load.resolve(runtime);expect(await one).toBe(runtime);
    const closing=f.registry.closeRuntime(session.sessionId);const reload=f.registry.ensureLoaded(session.sessionId);await tick();expect(runtime.closeCalls).toBe(1);expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
    const next=new FakeRuntime(session.sessionId,"runtime-two");next.closeGate.resolve(clean);f.runtimeFactory.mockImplementation(()=>next);
    runtime.closeGate.resolve(clean);await closing;expect(await reload).toBe(next);expect(f.runtimeFactory).toHaveBeenCalledTimes(2);
  });
  it("cancels a load crossing close, closes its late runtime once, and does not resurrect an archived Session",async()=>{
    const load=deferred<FakeRuntime>();const f=await fixture(()=>load.promise);const session=f.create("one");
    const loading=f.registry.ensureLoaded(session.sessionId);const rejected=expect(loading).rejects.toMatchObject({code:"RUNTIME_CLOSING"});await tick();
    const closing=f.registry.closeRuntime(session.sessionId);const runtime=new FakeRuntime(session.sessionId,"late");load.resolve(runtime);await rejected;await tick();expect(runtime.closeCalls).toBe(1);
    runtime.closeGate.resolve(clean);await closing;
    f.registry.archive({authSubjectId:"primary-device",commandId:"archive"},{sessionId:session.sessionId,expectedRevision:f.registry.get(session.sessionId).revision});
    await expect(f.registry.ensureLoaded(session.sessionId)).rejects.toMatchObject({code:"SESSION_ARCHIVED"});
    expect(f.registry.readSnapshot(session.sessionId).session.status).toBe("archived");expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
  });
  it("clears only a failed load's own Promise and permits a clean retry",async()=>{
    const f=await fixture();const session=f.create("one");f.runtimeFactory.mockRejectedValueOnce(new Error("local factory rejected before spawning"));
    await expect(f.registry.ensureLoaded(session.sessionId)).rejects.toThrow("local factory rejected");
    const next=f.registry.ensureLoaded(session.sessionId);const duplicate=f.registry.ensureLoaded(session.sessionId);expect(next).toBe(duplicate);await next;
    expect(f.runtimeFactory).toHaveBeenCalledTimes(2);expect(f.registry.get(session.sessionId).residency).toBe("loaded");
  });
  it("journals an idle runtime close before the effect, returns accepted retries, and settles after proof",async()=>{
    const f=await fixture();const session=f.create("one");const runtime=await f.registry.ensureLoaded(session.sessionId);
    runtime.closeGate=Object.assign(runtime.closeGate,deferred<RuntimeCloseReport>());
    const input={sessionId:session.sessionId,expectedRevision:session.revision};const command={authSubjectId:"primary-device",commandId:"close"};
    const closing=f.registry.closeRuntimeCommand(command,input);await tick();
    expect(f.store.getCommandReceipt(command.authSubjectId,command.commandId)?.state).toBe("accepted");
    expect(f.catalog.runtimeCloseForSession(session.sessionId)?.state).toBe("accepted");expect(runtime.closeCalls).toBe(1);
    const retry=await f.registry.closeRuntimeCommand(command,input);expect(retry.reused).toBe(true);expect(runtime.closeCalls).toBe(1);
    runtime.closeGate.resolve(clean);const terminal=await closing;
    expect(terminal.summary.residency).toBe("unloaded");expect(f.store.getCommandReceipt(command.authSubjectId,command.commandId)?.state).toBe("completed");
    expect(f.registry.readEvents(session.sessionId).events.map((event)=>event.type)).toEqual(["session.created","session.runtime.closing","session.runtime.closed"]);
  });
  it("keeps uncertain closes durable and refuses a fresh runtime or archive after restart",async()=>{
    const f=await fixture();const session=f.create("one");const runtime=await f.registry.ensureLoaded(session.sessionId);
    runtime.closeGate=Object.assign(runtime.closeGate,deferred<RuntimeCloseReport>());
    const closing=f.registry.closeRuntimeCommand({authSubjectId:"primary-device",commandId:"unknown"},{sessionId:session.sessionId,expectedRevision:session.revision});await tick();
    runtime.closeGate.resolve({closed:true,producerStopped:false,clean:false,state:"recovery_required"});await closing;
    expect(f.store.getCommandReceipt("primary-device","unknown")?.state).toBe("outcome_unknown");
    const fresh=new SessionRegistry(f.catalog,f.workspaces,f.providers,{owner:f.owner,runtimeFactory:f.runtimeFactory});
    await expect(fresh.ensureLoaded(session.sessionId)).rejects.toMatchObject({code:"RECOVERY_BLOCKED"});
    expect(()=>fresh.archive({authSubjectId:"primary-device",commandId:"archive"},{sessionId:session.sessionId,expectedRevision:fresh.get(session.sessionId).revision})).toThrow();
    expect(f.runtimeFactory).toHaveBeenCalledTimes(1);
  });
  it("blocks recovery even without an active pointer and leaves history available",async()=>{
    const f=await fixture();const session=f.create("one");f.store.db.prepare("UPDATE sessions SET recovery_state='blocked',active_turn_id=NULL WHERE id=?").run(session.sessionId);
    await expect(f.registry.ensureLoaded(session.sessionId)).rejects.toMatchObject({code:"RECOVERY_BLOCKED"});
    expect(()=>f.registry.archive({authSubjectId:"primary-device",commandId:"archive"},{sessionId:session.sessionId,expectedRevision:session.revision})).toThrow("Session recovery");
    expect(f.registry.readEvents(session.sessionId).events).toHaveLength(1);expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
  it("rolls back catalog metadata, event, receipt and Session creation as one commit",async()=>{
    const f=await fixture();const remove=f.store.registerCommitHook(()=>{throw new Error("projection fault");});
    expect(()=>f.create("fault")).toThrow("projection fault");
    expect(f.registry.list().sessions).toHaveLength(0);expect(f.store.getCommandReceipt("primary-device","fault")).toBeUndefined();remove();
    const session=f.create("good");const fail=f.store.registerCommitHook(()=>{throw new Error("archive fault");});
    expect(()=>f.registry.archive({authSubjectId:"primary-device",commandId:"archive"},{sessionId:session.sessionId,expectedRevision:session.revision})).toThrow("archive fault");
    expect(f.registry.get(session.sessionId)).toEqual(session);expect(f.store.getCommandReceipt("primary-device","archive")).toBeUndefined();fail();
  });
  it("checks revocation and restore readiness before metadata writes or receipt reuse while preserving history reads",async()=>{
    const f=await fixture();const session=f.create("one");f.store.db.prepare("INSERT INTO host_state VALUES('restore_readiness',?,?)").run("malformed",new Date().toISOString());
    expect(()=>f.create("one")).toThrow("Restored external state");expect(()=>f.registry.rename({authSubjectId:"primary-device",commandId:"rename"},{sessionId:session.sessionId,expectedRevision:session.revision,title:"blocked"})).toThrow("Restored external state");
    expect(f.registry.readSnapshot(session.sessionId).session.title).toBe("one");f.store.db.prepare("DELETE FROM host_state WHERE key='restore_readiness'").run();
    f.store.createDevice({id:"primary-device",hostId:"host",platform:"test",credentialKind:"browser-session",credentialRevision:1,scopes:["session:read","session:write"],createdAt:new Date().toISOString(),revokedAt:new Date().toISOString()});
    expect(()=>f.create("one")).toThrow("DEVICE_REVOKED");expect(f.registry.list().sessions).toHaveLength(1);
  });
  it("updates scoped private native handles inside event transactions and rejects conversation swaps",async()=>{
    const f=await fixture();const session=f.create("one");
    f.store.commitEvent(session.sessionId,"provider.init",{}, {providerSessionId:"native-one"});
    expect(f.catalog.requireSession(session.sessionId).nativeHandle).toMatchObject({workspaceId:"workspace-one",providerInstanceId:"instance-claude",nativeSessionId:"native-one"});
    expect(f.registry.get(session.sessionId).nativeSessionAvailable).toBe(true);expect(JSON.stringify(f.registry.readSnapshot(session.sessionId))).not.toContain("native-one");
    expect(()=>f.store.commitEvent(session.sessionId,"provider.init",{}, {providerSessionId:"different-native"})).toThrow("Native conversation cannot silently change");
    expect(f.store.getSession(session.sessionId)?.providerSessionId).toBe("native-one");expect(f.registry.readEvents(session.sessionId).events).toHaveLength(2);
  });
  it("checks every session sharing a checkout or Provider beyond the public list cap",async()=>{
    const f=await fixture();for(let i=0;i<205;i++)f.create(`session-${i}`);
    const all=f.catalog.allSessions();const last=all[204]!;f.catalog.setResidency(last.sessionId,"blocked");
    expect(f.registry.list({limit:200}).sessions).toHaveLength(200);expect(f.registry.list({limit:200}).nextSessionId).toBeDefined();
    expect(()=>f.workspaces.assertNoWriterOrRuntime("workspace-one")).toThrow();
    expect(()=>f.providers.registerLocal({providerInstanceId:"instance-claude",provider:"claude",executable:process.execPath,config:{model:"changed"}})).toThrow("Close its runtimes");
  });
  it("intersects verified capabilities with adapter, policy, workspace and device scopes and rejects secret env",async()=>{
    const f=await fixture();expect(()=>f.providers.registerLocal({providerInstanceId:"unsafe",provider:"codex",executable:process.execPath,config:{environment:{API_KEY:"secret"}}})).toThrow("may not persist secrets");
    expect(f.providers.effectiveCapabilities("instance-claude",{adapter:["streamingText","workspaceWrite"],workspace:["streamingText","workspaceWrite"],deviceScopes:["session:read","session:write"]})).toEqual([]);
    f.providers.recordVerification("instance-claude",{state:"verified",runtimeVersion:"test-version",capabilities:["streamingText","workspaceWrite"]});
    expect(f.providers.effectiveCapabilities("instance-claude",{adapter:["streamingText","workspaceWrite"],workspace:["streamingText","workspaceWrite"],deviceScopes:["session:read"]})).toEqual(["streamingText"]);
  });
  it("reads Session-specific Diff baselines without loading either Provider",async()=>{
    const f=await fixture();writeFileSync(join(f.checkout,"tracked.txt"),"baseline\n");execFileSync("git",["-C",f.checkout,"add","tracked.txt"]);execFileSync("git",["-C",f.checkout,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--quiet","-m","baseline"]);
    const first=f.create("one");const head=execFileSync("git",["-C",f.checkout,"rev-parse","HEAD"],{encoding:"utf8"}).trim();f.store.setSessionBaseline(first.sessionId,{head,dirty:false,files:[]});
    writeFileSync(join(f.checkout,"tracked.txt"),"session-one-change\n");
    const diff=await f.registry.gitDiff(first.sessionId);expect(diff.baselineHead).toBe(head);expect(diff.diff).toContain("session-one-change");expect(f.runtimeFactory).not.toHaveBeenCalled();
  });
});

describe("SQL-only legacy catalog backfill",()=>{
  it("preserves one native Session and a stable default without verifying arbitrary legacy paths",()=>{
    const owner=createTestHostOwner();const store=new SqliteStore(":memory:",{mode:"test-fixture",fixtureSchema:FROZEN_V6_SCHEMA});cleanups.push(()=>{store.close();owner.release();});
    const session=store.createSession("/offline/old-checkout","codex","legacy-session");store.db.prepare("UPDATE sessions SET provider_session_id='legacy-native' WHERE id=?").run(session.id);
    applyCatalogMigration(store.db);const catalog=new CatalogStore(store);cleanups.push(()=>catalog.dispose());
    expect(catalog.legacyDefaultSessionId()).toBe(session.id);
    expect(catalog.requireSession(session.id)).toMatchObject({workspaceId:legacyWorkspaceId("/offline/old-checkout"),providerInstanceId:legacyProviderInstanceId("codex"),nativeSessionAvailable:true});
    expect(catalog.workspace(legacyWorkspaceId("/offline/old-checkout"))?.state).toBe("needs_verification");expect(catalog.provider(legacyProviderInstanceId("codex"))?.state).toBe("unconfigured");
    const before=catalog.requireSession(session.id);applyCatalogMigration(store.db);expect(catalog.requireSession(session.id)).toEqual(before);
  });
  it("does not select a newest default when legacy sources contain multiple active Sessions",()=>{
    const owner=createTestHostOwner();const store=new SqliteStore(":memory:",{mode:"test-fixture",fixtureSchema:FROZEN_V6_SCHEMA});cleanups.push(()=>{store.close();owner.release();});store.createSession("/old","claude","first");store.createSession("/old","claude","later");
    applyCatalogMigration(store.db);const catalog=new CatalogStore(store);cleanups.push(()=>catalog.dispose());expect(catalog.legacyDefaultSessionId()).toBeUndefined();catalog.setLegacyDefaultOnce("first");expect(catalog.legacyDefaultSessionId()).toBe("first");
  });
});

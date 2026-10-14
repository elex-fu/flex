import Database from "better-sqlite3";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {HostOwnerLock,type HostOwnerHandle} from "../lifecycle/host-owner.js";
import {openOwned,openForMaintenance} from "./open-store.js";
import type {SqliteStore} from "./db.js";
import {applyCatalogMigration} from "./migrations/007-catalog.js";
import {CatalogStore} from "./catalog-store.js";
import {CatalogImportService} from "./import-service.js";
import {WorkspaceRegistry} from "../workspace/workspace-registry.js";
import {ProviderInstanceRegistry} from "../provider/provider-instance-registry.js";
import {SessionRegistry} from "../session/session-registry.js";

const roots:string[]=[];const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
async function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"flyx-catalog-import-")));roots.push(root);
  const checkout=join(root,"checkout");mkdirSync(checkout);execFileSync("git",["init","--quiet",checkout]);
  const coordinationDirectory=join(root,"coordination");const mirror={hostId:randomUUID(),fingerprint:"a".repeat(64)};
  const ownerOptions=(name:string)=>({databasePath:join(root,name,"host.sqlite"),identityDirectory:join(root,name,"identity"),coordinationDirectory});
  const targetOptions=ownerOptions("target");const owner=HostOwnerLock.acquire({...targetOptions,mode:"maintenance"});
  mkdirSync(join(root,"target"),{recursive:true});const store=openForMaintenance({databasePath:owner.databasePath,owner});cleanups.push(()=>{store.close();owner.release();});store.setHostIdentityMirror(mirror);applyCatalogMigration(store.db);
  const catalog=new CatalogStore(store);cleanups.push(()=>catalog.dispose());
  const workspaces=new WorkspaceRegistry(catalog,{owner});await workspaces.registerLocal({workspaceId:"workspace-one",root:checkout});
  const providers=new ProviderInstanceRegistry(catalog);for(const provider of ["claude","codex"] as const)providers.registerLocal({providerInstanceId:`instance-${provider}`,provider,executable:process.execPath});
  const service=new CatalogImportService(catalog,workspaces,providers,{owner,backupDirectory:join(root,"backups")});
  const source=(name="source",provider:"claude"|"codex"="claude",sessionId=randomUUID())=>{
    const options=ownerOptions(name);const sourceOwner=HostOwnerLock.acquire(options);mkdirSync(join(root,name),{recursive:true});const sourceStore=openOwned({databasePath:sourceOwner.databasePath,owner:sourceOwner});sourceStore.setHostIdentityMirror(mirror);
    const session=sourceStore.createSession(checkout,provider,sessionId);sourceStore.db.prepare("UPDATE sessions SET provider_session_id=? WHERE id=?").run(`native-${name}`,sessionId);
    sourceStore.commitEvent(session.id,"assistant.message",{text:`history-${provider}`},{timeline:{itemId:`item-${name}`,kind:"assistant_message",status:"completed",content:{text:`history-${provider}`}}});
    sourceStore.putCommandReceipt({authSubjectId:`secondary-actor-${name}`,commandId:`historical-${name}`,method:"session.startTurn",requestHash:"original-legacy-hash",targetSessionId:session.id,requestFormatVersion:1,state:"completed",response:{status:"completed",original:true}});
    sourceStore.createAuthSession("private-secondary-auth","2099-01-01",`secondary-auth-${name}`);sourceStore.createPairingGrant("private-secondary-grant","2099-01-01",`secondary-grant-${name}`,{hostId:mirror.hostId,scopes:["session:write"]});
    sourceStore.createDevice({id:`secondary-actor-${name}`,hostId:mirror.hostId,displayName:"Secondary device",platform:"test",credentialKind:"browser-session",credentialRevision:1,scopes:["session:read","session:write"],createdAt:new Date().toISOString()});
    let closed=false;const close=()=>{if(!closed){closed=true;sourceStore.close();sourceOwner.release();}};cleanups.push(close);
    return {options,owner:sourceOwner,store:sourceStore,sessionId:session.id,close};
  };
  const input=(path:string)=>({sourceDatabasePath:path,legacyWorkspaceByCanonicalRoot:{[checkout]:"workspace-one"},legacyProviderInstances:{claude:"instance-claude",codex:"instance-codex"}});
  return {root,checkout,owner,store,catalog,workspaces,providers,service,source,input,mirror};
}

describe("offline same-Host catalog import",()=>{
  it("dry-runs readonly, takes consistent backups, preserves UUIDs/sequences/actors and never imports authorization",async()=>{
    const f=await fixture();const source=f.source();const sessionId=source.sessionId;const event=source.store.listEvents(sessionId,0,100).events[0]!;source.close();
    const sourceBytes=hash(source.options.databasePath);const before=f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    const plan=f.service.dryRun(f.input(source.options.databasePath));expect(plan.sessionIds).toEqual([sessionId]);expect(plan.counts.session_events).toBe(1);expect(hash(source.options.databasePath)).toBe(sourceBytes);expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual(before);
    const result=await f.service.import(plan);expect(result.reused).toBe(false);expect(existsSync(result.sourceBackupPath)).toBe(true);expect(existsSync(result.targetBackupPath)).toBe(true);
    expect(f.store.listEvents(sessionId,0,100).events).toEqual([event]);expect(f.catalog.requireSession(sessionId)).toMatchObject({workspaceId:"workspace-one",providerInstanceId:"instance-claude",provider:"claude",nativeSessionAvailable:true,residency:"unloaded"});
    expect(f.store.getCommandReceipt("secondary-actor-source","historical-source")).toMatchObject({requestHash:"original-legacy-hash",requestFormatVersion:1,targetSessionId:sessionId,response:{status:"completed",original:true}});
    expect(f.store.getDevice("secondary-actor-source")).toBeUndefined();expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({count:0});expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM pairing_grants").get()).toEqual({count:0});
    const backup=new Database(result.targetBackupPath,{readonly:true,fileMustExist:true});expect(backup.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({count:0});backup.close();
    expect(hash(source.options.databasePath)).toBe(sourceBytes);
    expect(await f.service.import(plan)).toEqual({...result,reused:true});expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM catalog_import_manifests").get()).toEqual({count:1});
  });
  it("imports separate Claude and Codex histories into one owned catalog without cross-line events or receipts",async()=>{
    const f=await fixture();const claude=f.source("claude-source","claude");const codex=f.source("codex-source","codex");claude.close();codex.close();
    await f.service.import(f.service.dryRun(f.input(claude.options.databasePath)));await f.service.import(f.service.dryRun(f.input(codex.options.databasePath)));
    expect(f.catalog.requireSession(claude.sessionId).providerInstanceId).toBe("instance-claude");expect(f.catalog.requireSession(codex.sessionId).providerInstanceId).toBe("instance-codex");
    expect(JSON.stringify(f.store.listEvents(claude.sessionId,0,100))).toContain("history-claude");expect(JSON.stringify(f.store.listEvents(claude.sessionId,0,100))).not.toContain("history-codex");
    expect(f.store.getCommandReceipt("secondary-actor-codex-source","historical-codex-source")?.targetSessionId).toBe(codex.sessionId);
  });
  it("requires a real offline source lock and exact Host fingerprint and configured binding",async()=>{
    const f=await fixture();const source=f.source();
    expect(()=>f.service.dryRun(f.input(source.options.databasePath))).toThrow("Another Host");
    source.close();const raw=new Database(source.options.databasePath);raw.prepare("UPDATE host_state SET value_json=? WHERE key='host_identity'").run(JSON.stringify({...f.mirror,fingerprint:"b".repeat(64)}));raw.close();
    expect(()=>f.service.dryRun(f.input(source.options.databasePath))).toThrow("IMPORT_HOST_IDENTITY_MISMATCH");
    const restore=new Database(source.options.databasePath);restore.prepare("UPDATE host_state SET value_json=? WHERE key='host_identity'").run(JSON.stringify(f.mirror));restore.close();
    expect(()=>f.service.dryRun({sourceDatabasePath:source.options.databasePath})).toThrow("Every source Session");
    expect(()=>f.service.dryRun({...f.input(source.options.databasePath),legacyProviderInstances:{claude:"instance-codex"}})).toThrow("IMPORT_BINDING_MISMATCH");
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM catalog_import_manifests").get()).toEqual({count:0});
  });
  it("aborts explicit UUID and actor-command conflicts instead of merging or granting actors",async()=>{
    const f=await fixture();const source=f.source();source.close();
    f.store.createSession(f.checkout,"claude",source.sessionId);f.store.db.prepare("UPDATE sessions SET workspace_id='workspace-one' WHERE id=?").run(source.sessionId);f.store.db.prepare("INSERT INTO session_catalog VALUES(?,'instance-claude','Existing',NULL,'unloaded',NULL)").run(source.sessionId);
    expect(()=>f.service.dryRun(f.input(source.options.databasePath))).toThrow("Conflicting sessions identity");
    expect(f.store.getDevice("secondary-actor-source")).toBeUndefined();expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM catalog_import_manifests").get()).toEqual({count:0});
  });
  it("revalidates source facts after dry-run and before any target publication",async()=>{
    const f=await fixture();const source=f.source();source.close();const plan=f.service.dryRun(f.input(source.options.databasePath));
    const owner=HostOwnerLock.acquire(source.options);const writer=openOwned({databasePath:owner.databasePath,owner});writer.commitEvent(source.sessionId,"late.fact",{});writer.close();owner.release();
    await expect(f.service.import(plan)).rejects.toThrow("Source facts changed after dry-run");
    expect(f.store.getSession(source.sessionId)).toBeUndefined();expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM catalog_import_manifests").get()).toEqual({count:0});
  });
  it("rolls back every target fact and manifest when a later insert fails, leaving the pre-import backup intact",async()=>{
    const f=await fixture();const source=f.source();source.close();const plan=f.service.dryRun(f.input(source.options.databasePath));
    f.store.db.exec("CREATE TRIGGER import_fault BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'import fact fault'); END");
    await expect(f.service.import(plan)).rejects.toThrow("import fact fault");
    expect(f.store.getSession(source.sessionId)).toBeUndefined();for(const table of ["session_catalog","session_events","command_receipts","catalog_import_manifests"])expect(f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({count:0});
    f.store.db.exec("DROP TRIGGER import_fault");expect((await f.service.import(plan)).reused).toBe(false);
  });
  it("preserves unresolved execution facts under a recovery gate and never creates a runtime during import",async()=>{
    const f=await fixture();const source=f.source();const accepted=source.store.acceptTurn({authSubjectId:"secondary-actor-source",sessionId:source.sessionId,turnId:randomUUID(),commandId:"pending",requestHash:"pending-original-hash",prompt:"not dispatched",generation:1,attemptId:"original-attempt"});source.close();
    await f.service.import(f.service.dryRun(f.input(source.options.databasePath)));
    expect(f.store.getActiveTurn(source.sessionId)?.id).toBe(accepted.turn.id);expect(f.store.getSession(source.sessionId)?.recoveryState).toBe("blocked");expect(f.catalog.requireSession(source.sessionId).residency).toBe("blocked");
    expect(f.store.getCommandReceipt("secondary-actor-source","pending")?.state).toBe("accepted");
    const factory=vi.fn();const registry=new SessionRegistry(f.catalog,f.workspaces,f.providers,{owner:f.owner,runtimeFactory:factory});await expect(registry.ensureLoaded(source.sessionId)).rejects.toMatchObject({code:"RECOVERY_BLOCKED"});expect(factory).not.toHaveBeenCalled();
  });
  it("rejects future or unsupported related fact schemas without modifying the source",async()=>{
    const f=await fixture();const source=f.source();source.close();let raw=new Database(source.options.databasePath);raw.exec("CREATE TABLE unsupported_fact(session_id TEXT REFERENCES sessions(id),id TEXT PRIMARY KEY)");raw.prepare("INSERT INTO unsupported_fact VALUES(?,?)").run(source.sessionId,"fact");raw.close();
    const sourceHash=hash(source.options.databasePath);expect(()=>f.service.dryRun(f.input(source.options.databasePath))).toThrow("Cannot silently discard unsupported_fact");expect(hash(source.options.databasePath)).toBe(sourceHash);
    raw=new Database(source.options.databasePath);raw.exec("DROP TABLE unsupported_fact; INSERT INTO schema_migrations VALUES(99,'future')");raw.close();const futureHash=hash(source.options.databasePath);expect(()=>f.service.dryRun(f.input(source.options.databasePath))).toThrow("newer than supported");expect(hash(source.options.databasePath)).toBe(futureHash);
  });
});

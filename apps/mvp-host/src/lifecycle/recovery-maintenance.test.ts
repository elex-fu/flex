import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostOwnerLock, type HostOwnerHandle, type OwnershipRecoveryProof, type RecoveryMaintenanceOwnerHandle } from "./host-owner.js";
import { SystemProcessInspector, type ProcessInspector } from "./process-inspector.js";
import { openForMaintenance, openForRecoveryMaintenance, openOwned, upgradeForRecoveryMaintenance } from "../storage/open-store.js";
import type { SqliteStore } from "../storage/db.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";

const roots:string[]=[];
const stores:SqliteStore[]=[];
const scopes:RecoveryMaintenanceOwnerHandle[]=[];
const owners:HostOwnerHandle[]=[];
afterEach(()=>{
  for(const store of stores.splice(0))store.close();
  for(const scope of scopes.splice(0)) {try{scope.closeMaintenance();}catch{/* Deliberate file replacement tests. */}}
  for(const owner of owners.splice(0)) {try{owner.release();}catch{/* Original retained records must remain. */}}
  for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
const inspector=(state:"alive"|"exited"|"unknown"):ProcessInspector=>({currentIdentity:()=>({pid:123,platform:"linux",birth:{kind:"linux",bootId:"12345678-1234-1234-1234-123456789abc",startTicks:"1"}}),inspect:()=>({state,reason:"test"})});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"flyx-recovery-maintenance-"));roots.push(root);
  const data=join(root,"data");mkdirSync(data,{mode:0o700});
  const options={databasePath:join(data,"host.sqlite"),identityDirectory:join(data,"identity"),coordinationDirectory:join(root,"coordination")};
  const original=HostOwnerLock.acquire({...options,inspector:inspector("exited")});owners.push(original);
  const store=openOwned({databasePath:options.databasePath,owner:original});
  const session=store.createSession("/offline-workspace");
  store.createTurn({sessionId:session.id,turnId:"unverified-turn",commandId:"start",requestHash:"hash",prompt:"not recovered by opening",generation:1});
  store.close();original.retain("producer_stop_unverified");
  const acquire=(probe:ProcessInspector=inspector("exited"))=>{const scope=HostOwnerLock.acquireForRecoveryMaintenance({...options,inspector:probe});scopes.push(scope);return scope;};
  const files=()=>readdirSync(options.coordinationDirectory).filter((file)=>file.endsWith(".owner")).sort().map((file)=>({path:join(options.coordinationDirectory,file),bytes:readFileSync(join(options.coordinationDirectory,file)),ino:statSync(join(options.coordinationDirectory,file)).ino}));
  return {root,options,original,session,acquire,files};
}
const proof=(owner:HostOwnerHandle):OwnershipRecoveryProof=>({ownerId:owner.ownerId,ownerGeneration:owner.generation,evidenceId:"stop-evidence",turnId:"unverified-turn",attemptId:"attempt",resourceKeys:owner.resourceKeys});

describe("retained owner recovery-maintenance bootstrap",()=>{
  it("holds exact original resources unchanged and refuses normal writer admission or proof-free release",()=>{
    const f=fixture();const before=f.files();const scope=f.acquire();
    expect(scope.ownerId).toBe(f.original.ownerId);expect(scope.generation).toBe(f.original.generation);expect(scope.recoveryOnly).toBe(true);
    expect(f.files()).toEqual(before);scope.heartbeat();expect(f.files()).toEqual(before);
    expect(readdirSync(f.options.coordinationDirectory).filter((file)=>file.endsWith(".maintenance"))).toHaveLength(2);
    expect(()=>HostOwnerLock.acquire({...f.options,mode:"maintenance",reclaimStale:true,recovery:{proof:proof(scope),verifyProof:()=>true},inspector:inspector("exited")})).toThrow("maintenance");
    expect(()=>scope.release()).toThrow("without committed stop evidence");
    expect(()=>openForMaintenance({databasePath:f.options.databasePath,owner:scope})).toThrow("cannot migrate");
    const store=openForRecoveryMaintenance({databasePath:f.options.databasePath,owner:scope});stores.push(store);
    expect(()=>store.assertWriterOwner()).toThrow("HOST_RECOVERY_ONLY");
    expect(()=>store.commitEvent(f.session.id,"business.forbidden",{})).toThrow("HOST_RECOVERY_ONLY");
    expect(store.getTurn("unverified-turn")?.status).toBe("queued");
    expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:SUPPORTED_SCHEMA_VERSION});
    expect(f.files()).toEqual(before);
    store.withRecoveryTransaction(()=>store.db.prepare("INSERT INTO host_state VALUES('recovery-evidence','\"stopped\"','now')").run());
    expect(()=>store.withRecoveryTransaction(async()=>{})).toThrow("SYNCHRONOUS_COMMIT_REQUIRED");
    scope.closeMaintenance();expect(f.files()).toEqual(before);
    expect(()=>HostOwnerLock.acquire(f.options)).toThrow("Another Host");
  });

  it("checks committed proof for every resource before clearing any retained record",()=>{
    const f=fixture();const scope=f.acquire();const before=f.files();
    expect(()=>scope.clearRetention(proof(scope),(_,context)=>context.resourceKey.startsWith("db:"))).toThrow("did not prove");
    expect(f.files()).toEqual(before);
    const store=openForRecoveryMaintenance({databasePath:f.options.databasePath,owner:scope});stores.push(store);
    const committed=()=>!store.db.inTransaction&&Boolean(store.db.prepare("SELECT 1 FROM host_state WHERE key='committed-stop'").get());
    expect(()=>store.withRecoveryTransaction(()=>{
      store.db.prepare("INSERT INTO host_state VALUES('committed-stop','true','now')").run();
      scope.clearRetention(proof(scope),committed);
    })).toThrow("did not prove");
    expect(store.db.prepare("SELECT 1 FROM host_state WHERE key='committed-stop'").get()).toBeUndefined();
    expect(f.files()).toEqual(before);
    store.withRecoveryTransaction(()=>store.db.prepare("INSERT INTO host_state VALUES('committed-stop','true','now')").run());
    scope.clearRetention(proof(scope),committed);
    expect(scope.retainedReason).toBeUndefined();scope.release();
    expect(readdirSync(f.options.coordinationDirectory)).toEqual([]);
    const successor=HostOwnerLock.acquire(f.options);owners.push(successor);successor.assertActive();
  });

  it("blocks alive, EPERM and unsupported birth checks and permits verified Linux PID reuse without killing the new process",()=>{
    const f=fixture();const before=f.files();
    expect(()=>f.acquire(inspector("alive"))).toThrow("cannot be proven exited");
    const denied=new SystemProcessInspector({platform:"linux",signal:()=>{throw Object.assign(new Error("denied"),{code:"EPERM"});}});
    expect(()=>f.acquire(denied)).toThrow("cannot be proven exited");
    const unsupported=new SystemProcessInspector({platform:"linux",signal:()=>{},read:()=>{throw new Error("cannot inspect birth");}});
    expect(()=>f.acquire(unsupported)).toThrow("cannot be proven exited");
    expect(f.files()).toEqual(before);
    const reused=new SystemProcessInspector({platform:"linux",signal:()=>{},read:(path)=>path.endsWith("boot_id")?"12345678-1234-1234-1234-123456789abc":`123 (reused) ${["S",...Array<string>(18).fill("0"),"2"].join(" ")}`});
    const scope=f.acquire(reused);scope.closeMaintenance();expect(f.files()).toEqual(before);
  });

  it("detects owner inode replacement during inspection and cleans only its partial guards",()=>{
    const f=fixture();let replaced=false;
    const racing:ProcessInspector={currentIdentity:inspector("exited").currentIdentity,inspect:()=>{
      if(!replaced){const file=f.files().find((item)=>(JSON.parse(item.bytes.toString()) as {resourceKey:string}).resourceKey.startsWith("db:"))!;
        writeFileSync(`${file.path}.replacement`,file.bytes,{mode:0o600});renameSync(`${file.path}.replacement`,file.path);replaced=true;}
      return {state:"exited",reason:"test"};
    }};
    expect(()=>f.acquire(racing)).toThrow("changed during process inspection");
    expect(f.files()).toHaveLength(2);
    expect(readdirSync(f.options.coordinationDirectory).filter((file)=>file.endsWith(".maintenance"))).toEqual([]);
  });

  it("detects a replaced held guard before committing recovery and never deletes its successor",()=>{
    const f=fixture();const scope=f.acquire();const guard=join(f.options.coordinationDirectory,readdirSync(f.options.coordinationDirectory).find((file)=>file.endsWith(".maintenance"))!);
    const content=readFileSync(guard);writeFileSync(`${guard}.replacement`,content,{mode:0o600});renameSync(`${guard}.replacement`,guard);
    expect(()=>scope.assertActive()).toThrow("no longer matches");
    expect(()=>scope.closeMaintenance()).toThrow("could not safely close");
    expect(readFileSync(guard)).toEqual(content);
  });

  it("rejects future schema and a removed database without creating or migrating a file",()=>{
    const f=fixture();
    const future=new Database(f.options.databasePath);future.prepare("INSERT INTO schema_migrations VALUES(99,'future')").run();future.close();
    const originalBytes=readFileSync(f.options.databasePath);const retained=f.files();const scope=f.acquire();
    expect(()=>openForRecoveryMaintenance({databasePath:f.options.databasePath,owner:scope})).toThrow("newer than supported");
    expect(readFileSync(f.options.databasePath)).toEqual(originalBytes);expect(f.files()).toEqual(retained);
    scope.closeMaintenance();
    rmSync(f.options.databasePath);
    const missing=f.acquire();
    expect(()=>openForRecoveryMaintenance({databasePath:f.options.databasePath,owner:missing})).toThrow();
    expect(readdirSync(join(f.root,"data"))).toEqual([]);missing.closeMaintenance();expect(f.files()).toEqual(retained);
  });

  it("runs explicit installed metadata upgrades only under retained guards and rolls back invalid or async upgrades",()=>{
    const f=fixture();const scope=f.acquire();const retained=f.files();
    const store=openForRecoveryMaintenance({databasePath:f.options.databasePath,owner:scope});stores.push(store);
    expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='recovery_probe'").get()).toBeUndefined();
    expect(()=>upgradeForRecoveryMaintenance(f.original,store.db,()=>{})).toThrow("held retained recovery-maintenance writer");
    store.withRecoveryTransaction(()=>upgradeForRecoveryMaintenance(scope,store.db,(db)=>db.exec("CREATE TABLE recovery_probe(evidence_id TEXT PRIMARY KEY)")));
    expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='recovery_probe'").get()).toBeDefined();
    expect(f.files()).toEqual(retained);
    expect(()=>upgradeForRecoveryMaintenance(scope,store.db,(db)=>{
      db.exec("CREATE TABLE forbidden_future_metadata(id TEXT); INSERT INTO schema_migrations VALUES(99,'future')");
    })).toThrow("newer than supported");
    expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='forbidden_future_metadata'").get()).toBeUndefined();
    expect(store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({version:SUPPORTED_SCHEMA_VERSION});
    expect(()=>upgradeForRecoveryMaintenance(scope,store.db,async()=>{})).toThrow("SYNCHRONOUS_METADATA_MIGRATION_REQUIRED");
    expect(()=>store.assertWriterOwner()).toThrow("HOST_RECOVERY_ONLY");
    expect(f.files()).toEqual(retained);scope.closeMaintenance();
  });
});

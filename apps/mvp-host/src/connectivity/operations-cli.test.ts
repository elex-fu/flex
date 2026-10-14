import Database from "better-sqlite3";
import { chmod,mkdtemp,readFile,realpath,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { HostOwnerLock,type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import type { SqliteStore } from "../storage/db.js";
import { getHostIdentityMirror,loadOrCreateHostIdentity } from "../identity/host-identity.js";
import { OperationSnapshotLane } from "../operations/host-operations.js";
import { digest } from "../operations/operation-files.js";
import { persistRelayRegistration,type RelayRegistration } from "../relay/relay-registration.js";
import { parseHostOperationsCommand,runHostOperationsCommand,type BackupCliBinding,type HostOperationsCliCommand,type HostOperationsCliContext,type RestoreCliBinding } from "./operations-cli.js";

const roots:string[]=[],owners:HostOwnerHandle[]=[],stores:SqliteStore[]=[],readers:Database.Database[]=[];
afterEach(async()=>{for(const reader of readers.splice(0))reader.close();for(const store of stores.splice(0))store.close();for(const owner of owners.splice(0))owner.release();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function command(args:string[]):HostOperationsCliCommand {const parsed=parseHostOperationsCommand(args);if(!parsed)throw new Error("missing operation");return parsed;}
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"flyx-operations-cli-")));roots.push(root);await chmod(root,0o700);
  const databasePath=join(root,"host.sqlite"),identityDirectory=join(root,"identity"),coordinationDirectory=join(root,"coordination");
  const owner=HostOwnerLock.acquire({databasePath,identityDirectory,coordinationDirectory});owners.push(owner);
  const store=openOwned({databasePath,owner});stores.push(store);
  const identity=await loadOrCreateHostIdentity({directory:identityDirectory});store.setHostIdentityMirror(getHostIdentityMirror(identity));
  const session=store.createSession(join(root,"workspace"));const lane=new OperationSnapshotLane(()=>owner.assertActive());
  const backup:BackupCliBinding={store,owner,identityDirectory,applicationVersion:"fixture",withSnapshot:lane.withSnapshot};
  const context:HostOperationsCliContext={databasePath,backup};
  return {root,databasePath,identityDirectory,coordinationDirectory,owner,store,identity,session,lane,backup,context};
}
async function offline(f:Awaited<ReturnType<typeof fixture>>){
  f.store.close();f.owner.release();
  const owner=HostOwnerLock.acquire({databasePath:f.databasePath,identityDirectory:f.identityDirectory,coordinationDirectory:f.coordinationDirectory,mode:"maintenance"});owners.push(owner);
  const restore:RestoreCliBinding={owner,databasePath:f.databasePath,identityDirectory:f.identityDirectory,applicationVersion:"fixture",verification:{verifyProducersStopped:()=>true,verifyDatabaseClosed:()=>!f.store.db.open}};
  return restore;
}

describe("strict pure operations routing",()=>{
  it("parses exact commands and rejects extra flags, missing directories and controls",()=>{
    expect(command(["doctor"])).toEqual({kind:"operations",action:"doctor"});
    expect(command(["backup","a directory"])).toEqual({kind:"operations",action:"backup",directory:"a directory"});
    expect(command(["validate","./backup"])).toEqual({kind:"operations",action:"validate",directory:"./backup"});
    expect(command(["restore","backup","rollback"])).toEqual({kind:"operations",action:"restore",directory:"backup",rollbackDirectory:"rollback"});
    expect(parseHostOperationsCommand(["catalog","dry-run"])).toBeUndefined();
    for(const args of [["doctor","extra"],["backup"],["backup",""],["backup","--force"],["validate","backup","extra"],["restore","backup"],["restore","backup","rollback","--force"],["backup","bad"+String.fromCharCode(0)+"path"]])expect(()=>parseHostOperationsCommand(args)).toThrow("OPERATIONS_INVALID_COMMAND");
  });
  it("readonly doctor never creates a missing database or touches mutation bindings",async()=>{
    const root=await mkdtemp(join(tmpdir(),"flyx-doctor-cli-"));roots.push(root);const databasePath=join(root,"missing","host.sqlite");
    const context={databasePath,get backup():BackupCliBinding{throw new Error("must not construct a runtime");},get restore():RestoreCliBinding{throw new Error("must not acquire an owner");}};
    await expect(runHostOperationsCommand(command(["doctor"]),context)).rejects.toThrow();await expect(stat(join(root,"missing"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("reads a future schema without migration, repair or private identity work",async()=>{
    const f=await fixture();f.store.db.pragma("user_version = 999");f.store.close();const before=digest(await readFile(f.databasePath));
    const result=await runHostOperationsCommand(command(["doctor"]),{databasePath:f.databasePath});
    expect(result).toMatchObject({owner:{mode:"read_only",state:"unverified"},schema:{writable:false},readiness:{reasonCodes:expect.arrayContaining(["SCHEMA_TOO_NEW"])}});
    expect(digest(await readFile(f.databasePath))).toBe(before);f.owner.assertActive();
  });
});

describe("owned backup and independently verified offline restore",()=>{
  it("refuses backup without an explicit shared lane or with a mismatched owner identity",async()=>{
    const f=await fixture();const directory=join(f.root,"never");
    await expect(runHostOperationsCommand(command(["backup",directory]),{databasePath:f.databasePath})).rejects.toThrow("BACKUP_RUNTIME_REQUIRED");
    await expect(runHostOperationsCommand(command(["backup",directory]),{databasePath:f.databasePath,backup:{...f.backup,withSnapshot:undefined} as unknown as BackupCliBinding})).rejects.toThrow("BACKUP_COORDINATOR_REQUIRED");
    await expect(runHostOperationsCommand(command(["backup",directory]),{databasePath:f.databasePath,backup:{...f.backup,identityDirectory:join(f.root,"foreign-identity")}})).rejects.toThrow("OPERATIONS_OWNER_MISMATCH");
    await expect(stat(directory)).rejects.toMatchObject({code:"ENOENT"});
  });
  it("waits the actual identity/Relay lane and validates its committed registration generation",async()=>{
    const f=await fixture();const registrationPath=join(f.identityDirectory,"relay-registration.json"),relayUrl="wss://fixture.invalid";
    const registration:RelayRegistration={v:1,relayUrl,routeId:Buffer.alloc(24,1).toString("base64url"),relayCredential:Buffer.alloc(32,2).toString("base64url"),createdAt:"2026-10-01T00:00:00.000Z",generation:1};
    await f.lane.withSnapshot(()=>persistRelayRegistration(registrationPath,registration));
    let release!:()=>void,entered!:()=>void;const barrier=new Promise<void>((done)=>{release=done;}),started=new Promise<void>((done)=>{entered=done;});
    const mutation=f.lane.withSnapshot(async()=>{entered();await barrier;await persistRelayRegistration(registrationPath,{...registration,generation:2});});await started;
    const directory=join(f.root,"backup");const creating=runHostOperationsCommand(command(["backup",directory]),{databasePath:f.databasePath,backup:{...f.backup,relay:{registrationPath,relayUrl}}});
    await new Promise<void>((done)=>setImmediate(done));await expect(stat(directory)).rejects.toMatchObject({code:"ENOENT"});release();await mutation;
    expect(await creating).toMatchObject({manifest:{relay:{generation:2},identity:{fingerprint:f.identity.fingerprint}}});
    expect(await runHostOperationsCommand(command(["validate",directory]),{databasePath:join(f.root,"not-opened.sqlite")})).toMatchObject({relay:{generation:2},includesExternalGitOrProviderHistory:false});
    await expect(stat(join(f.root,"not-opened.sqlite"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("does not infer stopped producers from a runtime or maintenance owner",async()=>{
    const f=await fixture();const directory=join(f.root,"backup"),rollbackDirectory=join(f.root,"never");await runHostOperationsCommand(command(["backup",directory]),f.context);
    const runtime:RestoreCliBinding={...f.backup,databasePath:f.databasePath,verification:{verifyProducersStopped:()=>true,verifyDatabaseClosed:()=>true}};
    await expect(runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore:runtime})).rejects.toThrow("RESTORE_OFFLINE_OWNER_REQUIRED");
    const restore=await offline(f);const before=digest(await readFile(f.databasePath));
    for(const verification of [undefined,{verifyProducersStopped:()=>false,verifyDatabaseClosed:()=>true},{verifyProducersStopped:()=>{},verifyDatabaseClosed:()=>true},{verifyProducersStopped:()=>Promise.resolve(true),verifyDatabaseClosed:()=>true}]){
      await expect(runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore:{...restore,verification} as unknown as RestoreCliBinding})).rejects.toThrow("RESTORE_PRODUCERS_UNVERIFIED");
    }
    expect(digest(await readFile(f.databasePath))).toBe(before);await expect(stat(rollbackDirectory)).rejects.toMatchObject({code:"ENOENT"});restore.owner.assertActive();
  });
  it("requires all real target handles closed and binds proof to the genuine resource scope",async()=>{
    const f=await fixture();const directory=join(f.root,"backup"),rollbackDirectory=join(f.root,"never");await runHostOperationsCommand(command(["backup",directory]),f.context);const restore=await offline(f);
    const reader=new Database(f.databasePath,{readonly:true,fileMustExist:true});readers.push(reader);let inspected=0;
    restore.verification={verifyProducersStopped:(scope)=>{expect(scope).toMatchObject({databasePath:restore.owner.databasePath,identityDirectory:restore.owner.identityDirectory,ownerId:restore.owner.ownerId,ownerGeneration:restore.owner.generation,resourceKeys:restore.owner.resourceKeys});expect(Object.isFrozen(scope)).toBe(true);inspected++;return true;},verifyDatabaseClosed:()=>!reader.open};
    await expect(runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore})).rejects.toThrow("RESTORE_DATABASE_NOT_CLOSED");expect(inspected).toBe(1);
    await expect(stat(rollbackDirectory)).rejects.toMatchObject({code:"ENOENT"});
    await expect(runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore:{...restore,owner:{...restore.owner} as HostOwnerHandle}})).rejects.toThrow("verified Host owner");
  });
  it("creates a rollback point and leaves installed history behind the external readiness gate",async()=>{
    const f=await fixture();const directory=join(f.root,"backup"),rollbackDirectory=join(f.root,"rollback");await runHostOperationsCommand(command(["backup",directory]),f.context);
    f.store.commitEvent(f.session.id,"fixture.changed",{message:"newer history"});const restore=await offline(f);let proofs=0;
    restore.verification.verifyProducersStopped=()=>{proofs++;return true;};
    const result=await runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore});
    expect(result).toMatchObject({rollbackDirectory,readiness:{status:"external_state_unverified"}});expect(proofs).toBeGreaterThan(2);
    const current=new Database(f.databasePath,{readonly:true,fileMustExist:true}),rollback=new Database(join(rollbackDirectory,"database.sqlite"),{readonly:true,fileMustExist:true});readers.push(current,rollback);
    expect(current.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type='fixture.changed'").get()).toEqual({n:0});expect(rollback.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type='fixture.changed'").get()).toEqual({n:1});
    expect(await runHostOperationsCommand(command(["doctor"]),{databasePath:f.databasePath})).toMatchObject({readiness:{reasonCodes:expect.arrayContaining(["RESTORE_GIT_STATE_UNVERIFIED","RESTORE_PROVIDER_HISTORY_UNVERIFIED"])}});
  });
  it("rechecks independent closure evidence immediately before installation",async()=>{
    const f=await fixture();const directory=join(f.root,"backup"),rollbackDirectory=join(f.root,"rollback");await runHostOperationsCommand(command(["backup",directory]),f.context);f.store.commitEvent(f.session.id,"fixture.changed",{});const restore=await offline(f);const before=digest(await readFile(f.databasePath));let stillStopped=true;
    restore.verification.verifyProducersStopped=()=>stillStopped;restore.beforeInstall=()=>{stillStopped=false;};
    await expect(runHostOperationsCommand(command(["restore",directory,rollbackDirectory]),{databasePath:f.databasePath,restore})).rejects.toThrow("RESTORE_PRODUCERS_UNVERIFIED");
    expect(digest(await readFile(f.databasePath))).toBe(before);expect(await runHostOperationsCommand(command(["validate",rollbackDirectory]),{databasePath:f.databasePath})).toMatchObject({includesExternalGitOrProviderHistory:false});restore.owner.assertActive();
  });
});

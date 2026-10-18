import { expect,it } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../storage/db.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { CheckpointService } from "./checkpoint-service.js";
import { CheckpointGitDriver } from "./git-driver.js";
import { rawCheckpointGitRunner } from "../test-support/managed-git-fixtures.js";
import { checkpointFixture,fixtureGit,temporaryRepository } from "./test-support.js";
it("leaves capturing journal and both generated ref pins intact after seal and late Git completion",async()=>{
 const root=await temporaryRepository();const directory=await mkdtemp(join(tmpdir(),"flyx-checkpoint-seal-"));const dbPath=join(directory,"state.sqlite");const f=checkpointFixture(root,dbPath);
 let release!:()=>void;let reached!:()=>void;const entered=new Promise<void>((resolve)=>{reached=resolve;});const gate=new Promise<void>((resolve)=>{release=resolve;});
 const driver=new CheckpointGitDriver(root,{runGit:rawCheckpointGitRunner(),onBoundary:async(boundary)=>{if(boundary==="refs_written"){reached();await gate;}}});
 const service=new CheckpointService({store:f.store,driverFor:()=>driver,assertLease:()=>{}});let reopened:SqliteStore|undefined;
 try {
   const capture=service.captureCurrent(f.context,"preview");await entered;const journal=f.store.list(f.context.sessionId)[0]!;expect(journal.status).toBe("capturing");
   service.seal();f.owner.close();release();await expect(capture).rejects.toThrow("sealed");await service.drain();expect(()=>service.captureCurrent(f.context,"preview")).toThrow("sealed");
   reopened=new SqliteStore(dbPath);const store=new CheckpointStore(reopened.db);expect(store.require(journal.checkpointId,f.context.sessionId).status).toBe("capturing");
   const pins=store.protectedRefs();expect(pins.some((pin)=>pin.checkpointId===journal.checkpointId)).toBe(true);
   for(const ref of [journal.workspaceRef,journal.indexRef])expect((await fixtureGit(root,["rev-parse","--verify",`${ref}^{tree}`])).toString().trim()).toMatch(/^[a-f0-9]{40,64}$/);
 } finally {if(f.owner.db.open)f.owner.close();reopened?.close();await rm(root,{recursive:true,force:true});await rm(directory,{recursive:true,force:true});}
},15_000);

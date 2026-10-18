import {execFileSync} from "node:child_process";
import {mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {HostOwnerLock,createTestHostOwner} from "../lifecycle/host-owner.js";
import {openOwned} from "../storage/open-store.js";
import {CatalogStore} from "../storage/catalog-store.js";
import {applyCatalogMigration} from "../storage/migrations/007-catalog.js";
import {WorkspaceRegistry} from "./workspace-registry.js";
import {rawWorkspaceGitQuery} from "../test-support/managed-git-fixtures.js";

const roots:string[]=[];const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanups.splice(0).reverse())fn();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function repo(path:string) {mkdirSync(path,{recursive:true});execFileSync("git",["init","--quiet",path]);writeFileSync(join(path,"README.md"),"baseline\n");execFileSync("git",["-C",path,"add","README.md"]);execFileSync("git",["-C",path,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--quiet","-m","baseline"]);}
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),"flyx-workspace-catalog-")));roots.push(root);const checkout=join(root,"checkout");repo(checkout);const owner=createTestHostOwner();const store=openOwned({databasePath:":memory:",owner});applyCatalogMigration(store.db);const catalog=new CatalogStore(store);cleanups.push(()=>{catalog.dispose();store.close();owner.release();});return {root,checkout,owner,store,catalog,registry:new WorkspaceRegistry(catalog,{owner,readOnlyGit:rawWorkspaceGitQuery()})};}
describe("controlled Workspace registration",()=>{
  it("records the configured root separately from the actual checkout key and rejects private-directory overlap",async()=>{
    const f=fixture();const nested=join(f.checkout,"subdirectory");mkdirSync(nested);const row=await f.registry.registerLocal({workspaceId:"nested",root:nested});expect(row.canonicalRoot).toBe(nested);expect(row.worktreeRoot).toBe(f.checkout);
    const privateRegistry=new WorkspaceRegistry(f.catalog,{owner:f.owner,privateDirectories:[join(f.checkout,"private-data")],readOnlyGit:rawWorkspaceGitQuery()});await expect(privateRegistry.registerLocal({workspaceId:"unsafe",root:f.checkout})).rejects.toThrow("overlaps");expect(f.catalog.workspace("unsafe")).toBeUndefined();
  });
  it("uses the configured data directory rather than only the SQLite file for file-backed privacy admission",async()=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),"flyx-private-catalog-")));roots.push(root);const data=join(root,"private");mkdirSync(data);const checkout=join(data,"checkout");repo(checkout);
    const owner=HostOwnerLock.acquire({databasePath:join(data,"host.sqlite"),coordinationDirectory:join(root,"coordination")});const store=openOwned({databasePath:owner.databasePath,owner});applyCatalogMigration(store.db);const catalog=new CatalogStore(store);cleanups.push(()=>{catalog.dispose();store.close();owner.release();});
    const registry=new WorkspaceRegistry(catalog,{owner,readOnlyGit:rawWorkspaceGitQuery()});await expect(registry.registerLocal({workspaceId:"unsafe",root:checkout})).rejects.toThrow("overlaps");expect(catalog.workspaces()).toEqual([]);
  });
  it("publishes only a prepared actual worktree from the registered repository in the shared commit",async()=>{
    const f=fixture();await f.registry.registerLocal({workspaceId:"repository",root:f.checkout,repositoryId:"repo"});const path=join(f.root,"generated");execFileSync("git",["-C",f.checkout,"worktree","add","--detach",path,"HEAD"],{stdio:"pipe"});
    const prepared=await f.registry.prepareWorktreeRegistration({workspaceId:"generated",root:path,repositoryId:"repo",operationId:"operation"});expect(f.catalog.workspace("generated")).toBeUndefined();expect(()=>prepared.capabilities.push("fabricated")).toThrow();
    f.store.db.exec("CREATE TABLE operation_probe(id TEXT PRIMARY KEY)");expect(()=>f.store.db.transaction(()=>{f.registry.commitWorktreeRegistration(prepared,"operation");f.store.db.prepare("INSERT INTO operation_probe VALUES(?)").run("operation");throw new Error("transaction fault");})()).toThrow("transaction fault");
    expect(f.catalog.workspace("generated")).toBeUndefined();expect(f.store.db.prepare("SELECT * FROM operation_probe").all()).toEqual([]);
    const published=f.registry.commitWorktreeRegistration(prepared,"operation");expect(published.kind).toBe("worktree");expect(published.worktreeRoot).toBe(path);expect(published.checkoutKey).not.toBe(f.registry.require("repository").checkoutKey);
    expect(()=>f.registry.commitWorktreeRegistration({...prepared},"operation")).toThrow("WORKTREE_REGISTRATION_NOT_PREPARED");
  });
  it("rejects other repositories and rechecks moved prepared roots before publication",async()=>{
    const f=fixture();await f.registry.registerLocal({workspaceId:"repository",root:f.checkout,repositoryId:"repo"});const other=join(f.root,"other");repo(other);
    await expect(f.registry.prepareWorktreeRegistration({workspaceId:"wrong",root:other,repositoryId:"repo",operationId:"wrong-op"})).rejects.toThrow("different registered repository");
    const path=join(f.root,"generated");execFileSync("git",["-C",f.checkout,"worktree","add","--detach",path,"HEAD"],{stdio:"pipe"});const prepared=await f.registry.prepareWorktreeRegistration({workspaceId:"moved",root:path,repositoryId:"repo",operationId:"move-op"});renameSync(path,join(f.root,"quarantine"));expect(()=>f.registry.commitWorktreeRegistration(prepared,"move-op")).toThrow("Configured workspace moved");expect(f.catalog.workspace("moved")).toBeUndefined();
  });
});

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { basename,dirname } from "node:path";
import { z } from "zod";
import { assertHostOwner, assertWorkspacePrivacy, type HostOwnerHandle } from "../lifecycle/host-owner.js";
import { CatalogError, CatalogStore, type WorkspaceRecord } from "../storage/catalog-store.js";
import { checkoutKey } from "../storage/migrations/007-catalog.js";

const run = promisify(execFile);
const LocalWorkspaceConfig = z.strictObject({
  workspaceId:z.string().min(1).max(256),root:z.string().min(1),repositoryId:z.string().min(1).max(256).optional(),
  capabilities:z.array(z.string().min(1).max(128)).max(64).default(["streamingText","structuredToolCalls","gitDiff","workspaceWrite","interrupt","interactiveApprovals","resumeConversation"]),
});
export type LocalWorkspaceConfig = z.input<typeof LocalWorkspaceConfig>;
export type PreparedWorkspaceRegistration = Omit<WorkspaceRecord,"createdAt"|"updatedAt">;

export class WorkspaceRegistry {
  private readonly prepared = new WeakSet<object>();
  constructor(readonly catalog:CatalogStore,private readonly options:{owner:HostOwnerHandle;privateDirectories?:readonly string[]}) {}
  get(id:string) { return this.catalog.workspace(id); }
  require(id:string):WorkspaceRecord {
    const workspace=this.get(id); if (!workspace) throw new CatalogError("WORKSPACE_NOT_FOUND");
    if(workspace.state!=="active") throw new CatalogError("WORKSPACE_NOT_VERIFIED","Workspace must be verified through local Host configuration");
    this.assertCurrent(workspace); return workspace;
  }
  list() { return this.catalog.workspaces(); }
  listPublic() { return this.list().map((record)=>({workspaceId:record.workspaceId,label:basename(record.canonicalRoot),kind:record.kind,state:record.state,repositoryId:record.repositoryId})); }
  private assertCurrent(record:WorkspaceRecord):void {
    try { if(realpathSync(record.canonicalRoot)!==record.canonicalRoot || realpathSync(record.worktreeRoot)!==record.worktreeRoot) throw new Error("moved"); }
    catch { throw new CatalogError("WORKSPACE_MOVED","Configured workspace moved; verify it locally before execution"); }
    assertWorkspacePrivacy(record.canonicalRoot,this.privatePaths());
    assertWorkspacePrivacy(record.worktreeRoot,this.privatePaths());
  }
  private privatePaths():string[] { const owner=this.options.owner;return [...(owner.databasePath!==":memory:"?[dirname(owner.databasePath)]:[]),...(owner.identityDirectory?[owner.identityDirectory]:[]),...(owner.coordinationDirectory?[owner.coordinationDirectory]:[]),...(this.options.privateDirectories??[])]; }
  private async prepare(input:LocalWorkspaceConfig,kind:"local"|"worktree",operationId?:string):Promise<PreparedWorkspaceRegistration> {
    assertHostOwner(this.options.owner);
    const parsed=LocalWorkspaceConfig.parse(input);
    const canonicalRoot=realpathSync(parsed.root);
    const result=await run("git",["-c","core.fsmonitor=false","-C",canonicalRoot,"rev-parse","--show-toplevel"],{encoding:"utf8",maxBuffer:16*1024,timeout:5000});
    const worktreeRoot=realpathSync(result.stdout.trim());
    const record:PreparedWorkspaceRegistration={workspaceId:parsed.workspaceId,canonicalRoot,worktreeRoot,checkoutKey:checkoutKey(worktreeRoot),kind,state:"active",repositoryId:parsed.repositoryId??parsed.workspaceId,capabilities:parsed.capabilities,...(operationId?{registrationOperationId:operationId}:{})};
    this.assertCurrent({...record,createdAt:"",updatedAt:""}); this.options.owner.assertActive();
    Object.freeze(record.capabilities);this.prepared.add(record); return Object.freeze(record);
  }
  async registerLocal(input:LocalWorkspaceConfig):Promise<WorkspaceRecord> { const record=await this.prepare(input,"local"); return this.catalog.putWorkspace(record); }
  resolveRepository(repositoryId:string):WorkspaceRecord {
    const matches=this.list().filter((record)=>record.repositoryId===repositoryId&&record.kind==="local"&&record.state==="active");
    if(matches.length!==1) throw new CatalogError("REPOSITORY_NOT_FOUND","Repository must identify one locally registered checkout");
    return this.require(matches[0]!.workspaceId);
  }
  async prepareWorktreeRegistration(input:LocalWorkspaceConfig&{repositoryId:string;operationId:string}):Promise<PreparedWorkspaceRegistration> {
    const repository=this.resolveRepository(input.repositoryId);
    const {operationId,...config}=input;
    if(!operationId) throw new CatalogError("WORKTREE_OPERATION_REQUIRED");
    const record=await this.prepare(config,"worktree",operationId);
    if(record.canonicalRoot!==record.worktreeRoot)throw new CatalogError("WORKTREE_REGISTRATION_CONFLICT","Generated checkout must identify its actual Git worktree root");
    const common=async(root:string)=>realpathSync((await run("git",["-C",root,"rev-parse","--path-format=absolute","--git-common-dir"],{encoding:"utf8",maxBuffer:16*1024,timeout:5000})).stdout.trim());
    if(await common(repository.worktreeRoot)!==await common(record.worktreeRoot))throw new CatalogError("WORKTREE_REGISTRATION_CONFLICT","Generated worktree belongs to a different registered repository");
    return record;
  }
  commitWorktreeRegistration(prepared:PreparedWorkspaceRegistration,operationId:string):WorkspaceRecord {
    assertHostOwner(this.options.owner);
    if(!this.prepared.has(prepared)||prepared.kind!=="worktree"||prepared.registrationOperationId!==operationId) throw new CatalogError("WORKTREE_REGISTRATION_NOT_PREPARED");
    this.assertCurrent({...prepared,createdAt:"",updatedAt:""});this.resolveRepository(prepared.repositoryId);
    return this.catalog.putWorkspace(prepared);
  }
  async registerWorktree(input:LocalWorkspaceConfig&{repositoryId:string;operationId:string}):Promise<WorkspaceRecord> { return this.commitWorktreeRegistration(await this.prepareWorktreeRegistration(input),input.operationId); }
  assertNoWriterOrRuntime(workspaceId:string):void {
    const workspace=this.require(workspaceId);
    const sameCheckout=this.list().filter((record)=>record.checkoutKey===workspace.checkoutKey).map((record)=>record.workspaceId);
    for(const id of sameCheckout) for(const session of this.catalog.allSessions({workspaceId:id})) {
      this.catalog.assertIdle(session.sessionId);
      if(session.residency!=="unloaded") throw new CatalogError("WORKSPACE_BUSY","Workspace still has a resident or unverified runtime",true);
    }
  }
}

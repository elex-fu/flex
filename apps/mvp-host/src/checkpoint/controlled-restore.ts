import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROLLED_RESTORE_HELPER } from "./controlled-restore-helper.js";
import { digest, validateCheckpointPath } from "./git-driver.js";
import type { CheckpointGitDriver } from "./git-driver.js";
import { CheckpointError } from "./types.js";
import type { CheckpointManifest } from "./types.js";
import type { FileState, RestoreCapabilities, RestoreInspection, RevertStep } from "./revert-types.js";

export type ControlledRestoreOptions = {
  /** Trusted Host configuration only. This is never a client-selected executable. */
  pythonExecutable?: string;
  onSpawn?: (process: {pid:number;operationId:string;stepId:string;kind:"controlled_restore"}) => void | Promise<void>;
  onExit?: (process: {pid:number;operationId:string;stepId:string}) => void;
  /** Deterministic tests only; no production RPC carries this. */
  fault?: (step: RevertStep) => "half_write" | "after_replace" | "after_mutation" | "permission_denied" | "disk_full" | undefined;
};
export class ControlledRestore {
  private sealed=false;
  seal():void {this.sealed=true;}
  constructor(private readonly options: ControlledRestoreOptions = {}) {}
  async probe(): Promise<void> { await this.helper({op:"probe"}); }
  async identify(workspace: string, gitDirectory: string): Promise<RestoreCapabilities> {
    return this.helper({op:"identify",workspacePath:await realpath(workspace),gitPath:await realpath(gitDirectory)});
  }
  inspect(capabilities: RestoreCapabilities, paths: readonly string[], steps: readonly RevertStep[] = []): Promise<RestoreInspection> {
    for (const path of paths) validateCheckpointPath(path);
    return this.helper({op:"inspect",capabilities,paths:[...new Set(paths)],artifacts:steps.map((step)=>step.cleanup?.originalStep ?? step).filter((step) => step.kind === "workspace_file" || step.kind === "index")
      .map((step) => ({stepId:step.stepId,kind:step.kind === "index" ? "index":"file",...(step.path ? {path:step.path}: {})}))});
  }
  async verifyRepository(workspace: string, capabilities: RestoreCapabilities): Promise<void> {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1",GIT_NO_LAZY_FETCH:"1"});
    const query=(args:string[])=>new Promise<string>((resolve,reject)=>execFile("git",["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null",...args],{cwd:workspace,env,encoding:"utf8",timeout:30_000},(error,out)=>error?reject(new CheckpointError("WORKSPACE_BINDING_CHANGED","Registered repository mapping changed")):resolve(out.trim())));
    const gitDirectory=await realpath(await query(["rev-parse","--absolute-git-dir"]));
    const root=await realpath(await query(["rev-parse","--show-toplevel"]));
    if (gitDirectory!==capabilities.gitDirectory.path || root!==capabilities.workspace.path) throw new CheckpointError("WORKSPACE_BINDING_CHANGED","Registered repository mapping changed");
    await this.inspect(capabilities,[]);
  }
  async cleanup(operationId:string,capabilities:RestoreCapabilities,step:RevertStep,data:Buffer):Promise<unknown> {
    const original=step.cleanup!.originalStep;
    return this.helper({op:"cleanup",capabilities,path:original.path,originalKind:original.kind,stepId:step.stepId,artifactStepId:original.stepId,expected:step.expected,artifact:step.artifact,dataBase64:data.toString("base64")},{operationId,stepId:step.stepId});
  }
  async targetBytes(driver: CheckpointGitDriver, target: NonNullable<RevertStep["target"]>): Promise<Buffer> {
    if (target.kind === "absent" || target.kind === "directory") return Buffer.alloc(0);
    if (!target.oid || !["100644","100755","120000"].includes(target.mode ?? "")) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Restore target has no controlled blob");
    const data = await driver.blob(target.oid);
    if (!data || data.length !== target.bytes || digest(data) !== target.sha256 || this.objectOid(data,target.oid.length) !== target.oid) throw new CheckpointError("TARGET_OBJECT_CORRUPT", "Retained target bytes do not match their object identity");
    return data;
  }
  async prepareIndex(driver: CheckpointGitDriver, manifest: CheckpointManifest, capabilities: RestoreCapabilities): Promise<{data:Buffer;digest:string}> {
    const tree = await driver.verify(manifest,"index");
    // Every stage0 entry and raw object must be restorable; no filter/checkout/refresh touches user files.
    for (const entry of await driver.listTree(tree)) {
      if (!["100644","100755","120000"].includes(entry.mode)) throw new CheckpointError("CAPTURE_UNAVAILABLE", "Index contains an unsupported mode");
      const data = await driver.blob(entry.oid);
      if (!data || this.objectOid(data,entry.oid.length) !== entry.oid) throw new CheckpointError("TARGET_OBJECT_CORRUPT", "Retained index object is corrupt");
    }
    const temp=await mkdtemp(join(tmpdir(),"flyx-revert-index-"));
    try {
      const index=join(temp,"index"); await this.objectGit(capabilities.gitDirectory.path,temp,index,["read-tree",tree]);
      const actual=(await this.objectGit(capabilities.gitDirectory.path,temp,index,["write-tree"])).toString("ascii").trim();
      if (actual !== tree) throw new CheckpointError("TARGET_OBJECT_CORRUPT", "Prepared index differs from its retained tree");
      const data=await readFile(index); if (data.length>64*1024*1024) throw new CheckpointError("RESTORE_BUDGET_EXCEEDED", "Prepared index exceeds restore budget");
      return {data,digest:digest(Buffer.concat([Buffer.from("index\0"),data]))};
    } finally {await rm(temp,{recursive:true,force:true});}
  }
  async apply(operationId: string, capabilities: RestoreCapabilities, step: RevertStep, data: Buffer): Promise<{file?:FileState;indexState?:FileState;indexDigest?:string}> {
    if (!["workspace_file","mkdir","index"].includes(step.kind)) throw new CheckpointError("REVERT_STEP_INVALID", "Step is not a controlled restore action");
    if (step.path) validateCheckpointPath(step.path);
    const fault=this.options.fault?.(step);
    return this.helper({op:step.kind === "workspace_file" ? "file":step.kind,capabilities,stepId:step.stepId,path:step.path,
      expected:step.expected,target:step.target,artifact:step.artifact,expectedIndexDigest:step.expectedIndexDigest,dataBase64:data.toString("base64"),
      ...(fault ? {fault}: {})},{operationId,stepId:step.stepId});
  }
  private objectOid(data: Buffer, length: number): string { return createHash(length === 64 ? "sha256":"sha1").update(`blob ${data.length}\0`).update(data).digest("hex"); }
  private objectGit(gitDirectory: string, workspace: string, index: string, args: string[]): Promise<Buffer> {
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
    Object.assign(env,{GIT_DIR:gitDirectory,GIT_WORK_TREE:workspace,GIT_INDEX_FILE:index,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_OPTIONAL_LOCKS:"0",GIT_NO_REPLACE_OBJECTS:"1",GIT_NO_LAZY_FETCH:"1",GIT_TERMINAL_PROMPT:"0"});
    const config=["core.fsmonitor=false","core.hooksPath=/dev/null","core.attributesFile=/dev/null","core.untrackedCache=false","core.preloadIndex=false","core.splitIndex=false","gc.auto=0","maintenance.auto=false"];
    return new Promise((resolve,reject)=>execFile("git",[...config.flatMap((value)=>["-c",value]),...args],{cwd:workspace,env,encoding:"buffer",timeout:30_000,maxBuffer:1024*1024},
      (error,out)=>error ? reject(new CheckpointError("GIT_OPERATION_FAILED","Controlled index preparation failed")):resolve(out)));
  }
  private helper<T>(request: unknown, producer?: {operationId:string;stepId:string}): Promise<T> {
    if(this.sealed)return Promise.reject(new CheckpointError("CONTROLLED_RESTORE_SEALED","Controlled restore is sealed"));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("PYTHON")));
    return new Promise((resolve,reject)=>{
      const child=execFile(this.options.pythonExecutable ?? "/usr/bin/python3",["-I","-c",CONTROLLED_RESTORE_HELPER],{env,encoding:"utf8",timeout:30_000,maxBuffer:16*1024*1024},(error,out)=>{
        if (producer && child.pid)try{this.options.onExit?.({pid:child.pid,...producer});}catch{ /* Original dispatch marker remains if process journal is sealed. */ }
        if (error) {reject(new CheckpointError("CONTROLLED_RESTORE_UNAVAILABLE","Controlled restore helper did not complete"));return;}
        try {
          const result=JSON.parse(out) as {ok:boolean;result:T;code?:string};
          if (!result.ok) throw new CheckpointError(result.code ?? "RESTORE_HELPER_FAILED","Controlled restore action failed");
          resolve(result.result);
        } catch(error) {reject(error instanceof CheckpointError ? error:new CheckpointError("RESTORE_HELPER_FAILED","Controlled restore helper returned invalid data"));}
      });
      child.stdin?.on("error",()=>{});
      void Promise.resolve(producer && child.pid ? this.options.onSpawn?.({pid:child.pid,...producer,kind:"controlled_restore"}):undefined)
        .then(()=>{if(this.sealed){child.kill("SIGKILL");child.stdin?.destroy();}else child.stdin?.end(JSON.stringify(request));},()=>{child.kill("SIGKILL");child.stdin?.destroy();});
    });
  }
}
export function sameFileContent(actual: FileState, desired: FileState): boolean {
  return actual.kind === desired.kind && (desired.kind === "directory" || ["mode","sha256","bytes"].every((key)=>actual[key as keyof FileState] === desired[key as keyof FileState]));
}

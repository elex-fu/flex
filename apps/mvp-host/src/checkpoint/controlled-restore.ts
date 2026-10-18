import { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROLLED_RESTORE_HELPER } from "./controlled-restore-helper.js";
import { digest, validateCheckpointPath, type CheckpointGitOperation, type CheckpointGitRunner, type CheckpointGitRunResult } from "./git-driver.js";
import type { CheckpointGitDriver } from "./git-driver.js";
import { CheckpointError } from "./types.js";
import type { CheckpointManifest } from "./types.js";
import type { FileState, RestoreCapabilities, RestoreInspection, RevertStep } from "./revert-types.js";

export type ControlledHelperSpawnRequest = {
  command: string; args: readonly string[]; env: NodeJS.ProcessEnv;
  purpose: "probe" | "read" | "mutate"; operationId?: string; stepId?: string;
  /** Trusted registered root for boundary selection; never accepted from RPC. */
  workspace?: string;
};
export type ControlledRestoreOptions = {
  /** Production injects prelaunch process journaling and the verified execution boundary. */
  spawnHelper?: (request: ControlledHelperSpawnRequest) => ChildProcess | Promise<ChildProcess>;
  /** Trusted Host configuration only. This is never a client-selected executable. */
  pythonExecutable?: string;
  /** Managed Git runner for repository binding and isolated-index queries. Without it restore refuses; there is no direct fallback. */
  runGit?: CheckpointGitRunner;
  onSpawn?: (process: {pid:number;operationId:string;stepId:string;kind:"controlled_restore"}) => void | Promise<void>;
  onExit?: (process: {pid:number;operationId:string;stepId:string}) => void;
  /** Deterministic tests only; no production RPC carries this. */
  fault?: (step: RevertStep) => "half_write" | "after_replace" | "after_mutation" | "permission_denied" | "disk_full" | undefined;
};
export class ControlledRestore {
  private sealed=false;
  private readonly lifecycle=new AbortController();
  seal():void {this.sealed=true;this.lifecycle.abort();}
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
    const query = async (args: string[]): Promise<string> => {
      const result = await this.restoreGit({ kind: "fingerprint" }, args, workspace, {}, 64 * 1024);
      if (result.exitCode !== 0) throw new CheckpointError("WORKSPACE_BINDING_CHANGED", "Registered repository mapping changed");
      return Buffer.from(result.stdout).toString("utf8").trim();
    };
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
      const operation=Object.freeze({kind:"verify" as const,checkpointId:manifest.checkpointId,layer:"index" as const});
      const index=join(temp,"index"); await this.objectGit(operation,capabilities.gitDirectory.path,temp,index,["read-tree",tree]);
      const actual=(await this.objectGit(operation,capabilities.gitDirectory.path,temp,index,["write-tree"])).toString("ascii").trim();
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
  /** One isolated-index query through the injected managed runner; no direct spawn fallback. */
  private async objectGit(operation: CheckpointGitOperation, gitDirectory: string, workspace: string, index: string, args: string[]): Promise<Buffer> {
    const env=Object.freeze({GIT_DIR:gitDirectory,GIT_WORK_TREE:workspace,GIT_INDEX_FILE:index});
    const result=await this.restoreGit(operation,args,workspace,env,1024*1024);
    if (result.exitCode !== 0) throw new CheckpointError("GIT_OPERATION_FAILED","Controlled index preparation failed");
    return Buffer.from(result.stdout);
  }
  private async restoreGit(operation: CheckpointGitOperation, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, maxBuffer: number): Promise<CheckpointGitRunResult> {
    const runner=this.options.runGit;
    // No direct spawn fallback: restore composition injects the journaling
    // managed runner, and a missing runner must refuse.
    if(!runner)throw new CheckpointError("CHECKPOINT_MANAGED_GIT_REQUIRED","Controlled restore requires the managed Git runner");
    return await runner(Object.freeze({command:"git",args:Object.freeze([...args]),cwd,workspace:cwd,env,maxInputBytes:0,maxBuffer,timeoutMs:30_000,signal:this.lifecycle.signal,operation:Object.freeze(operation)}));
  }
  private helper<T>(request: unknown, producer?: {operationId:string;stepId:string}): Promise<T> {
    if(this.sealed)return Promise.reject(new CheckpointError("CONTROLLED_RESTORE_SEALED","Controlled restore is sealed"));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("PYTHON")&&!/^(?:DYLD_|LD_|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$)/.test(key)));
    const operation=(request as {op?:string}).op;
    const workspace=(request as {workspacePath?:string;capabilities?:RestoreCapabilities}).workspacePath ?? (request as {capabilities?:RestoreCapabilities}).capabilities?.workspace.path;
    const launch:ControlledHelperSpawnRequest={command:this.options.pythonExecutable ?? "/usr/bin/python3",args:["-I","-c",CONTROLLED_RESTORE_HELPER],env,
      purpose:producer?"mutate":operation==="probe"?"probe":"read",...(producer??{}),...(workspace?{workspace}:{})};
    return new Promise<T>((resolve,reject)=>{
      let settled=false,child:ChildProcess|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      const fail=(code:string)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);try{child?.kill("SIGKILL");child?.stdin?.destroy();}catch{/* Root process journal still controls unknown producers. */}reject(new CheckpointError(code,"Controlled restore helper did not complete"));};
      // The trusted runner commits launch facts before crossing spawn; no mutation input is sent until it returns.
      void Promise.resolve().then(()=>{if(this.sealed)throw new CheckpointError("CONTROLLED_RESTORE_SEALED","Controlled restore is sealed");
        if(!this.options.spawnHelper)throw new CheckpointError("CONTROLLED_RESTORE_UNAVAILABLE","Controlled restore requires a managed helper launcher");
        return this.options.spawnHelper(launch);}).then((launched)=>{
        child=launched;const chunks:Buffer[]=[];let bytes=0;
        if(!child.stdin||!child.stdout){child.kill("SIGKILL");fail("CONTROLLED_RESTORE_UNAVAILABLE");return;}
        child.stderr?.resume();child.stdin.on("error",()=>{});
        child.stdout.on("data",(data:Buffer)=>{bytes+=data.length;if(bytes>16*1024*1024){child?.kill("SIGKILL");fail("RESTORE_BUDGET_EXCEEDED");return;}chunks.push(data);});
        child.once("error",()=>fail("CONTROLLED_RESTORE_UNAVAILABLE"));
        child.once("close",(code)=>{
          if(timer)clearTimeout(timer);
          if(producer&&child?.pid)try{this.options.onExit?.({pid:child.pid,...producer});}catch{/* Sealed original process journals remain unknown. */}
          if(settled)return;
          if(code!==0){fail("CONTROLLED_RESTORE_UNAVAILABLE");return;}
          try{
            const result=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {ok:boolean;result:T;code?:string};
            if(!result.ok){fail(result.code??"RESTORE_HELPER_FAILED");return;}
            settled=true;resolve(result.result);
          }catch{fail("RESTORE_HELPER_FAILED");}
        });
        timer=setTimeout(()=>{child?.kill("SIGKILL");fail("CONTROLLED_RESTORE_UNAVAILABLE");},30_000);
        void Promise.resolve(producer&&child.pid?this.options.onSpawn?.({pid:child.pid,...producer,kind:"controlled_restore"}):undefined).then(()=>{
          if(this.sealed){child?.kill("SIGKILL");child?.stdin?.destroy();}else child?.stdin?.end(JSON.stringify(request));
        },()=>{child?.kill("SIGKILL");child?.stdin?.destroy();});
      },()=>fail("CONTROLLED_RESTORE_UNAVAILABLE")).catch(()=>fail("CONTROLLED_RESTORE_UNAVAILABLE"));
    });
  }
}
export function sameFileContent(actual: FileState, desired: FileState): boolean {
  return actual.kind === desired.kind && (desired.kind === "directory" || ["mode","sha256","bytes"].every((key)=>actual[key as keyof FileState] === desired[key as keyof FileState]));
}

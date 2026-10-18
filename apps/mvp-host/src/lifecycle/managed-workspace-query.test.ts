import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createManagedWorkspaceQuery,
  macosWorkspaceQueryReadOnlyProfile,
  planManagedWorkspaceQuery,
  type ManagedWorkspaceQueryInput,
} from "./managed-workspace-query.js";
import {
  MANAGED_PROCESS_SCHEMA, MANAGED_PROCESS_IDENTITY_SCHEMA,
  ManagedProcessRegistry, SqliteProcessJournal, type ManagedProcessRecord,
} from "./managed-process-registry.js";
import { createFixtureManagedGitRunner } from "../test-support/managed-git-fixtures.js";

const run = promisify(execFile);
const context = { hostOwnerId: "query-owner", hostOwnerGeneration: 1, runtimeId: "query-runtime", runtimeGeneration: 1, attemptId: "query-attempt" };
const git = "/Library/Developer/CommandLineTools/usr/bin/git";
function input(cwd: string, common = false): ManagedWorkspaceQueryInput {
  return { cwd, argv: ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", ...(common ? ["--path-format=absolute", "--git-common-dir"] : ["--show-toplevel"])], maxBufferBytes: 16 * 1024, timeoutMs: 5_000 };
}

describe("fail-closed Workspace query port", () => {
  let root: string, workspace: string, privateRoot: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "flyx-query-port-")));
    workspace = join(root, "checkout space-雪");
    privateRoot = join(root, "host-private");
    await Promise.all([workspace, privateRoot].map(path => mkdir(path, { mode: 0o700 })));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("returns unavailable before any journal write and keeps SQL-only data usable", async () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE history(value TEXT); INSERT INTO history VALUES('authoritative')");
      let writes = 0, assertions = 0;
      const tracked: Promise<unknown>[] = [];
      const service = createManagedWorkspaceQuery({
        journal: { save: () => { writes++; } }, context: () => context,
        assertActive: () => { assertions++; }, privateRoots: [privateRoot], gitExecutable: git,
        trackOperation: work => { tracked.push(work); },
      });
      const readiness = await service.prepare();
      if (readiness.ready) throw new Error("A runner-less port must never become ready");
      expect(readiness).toMatchObject({ ready: false, code: process.platform === "darwin" ? "WORKSPACE_QUERY_PROCESS_BIRTH_UNAVAILABLE" : "WORKSPACE_QUERY_PLATFORM_UNSUPPORTED" });
      if (process.platform === "darwin") await expect(service.readOnlyGit(input(workspace))).rejects.toMatchObject({ code: readiness.code });
      expect(writes).toBe(0);
      expect(assertions).toBeGreaterThan(0);
      expect(db.prepare("SELECT value FROM history").get()).toEqual({ value: "authoritative" });
      expect(await service.drain()).toEqual({ closed: true, producerStopped: true, clean: true });
      expect(await service.close()).toEqual({ closed: true, producerStopped: true, clean: true });
      service.seal();
      await expect(service.readOnlyGit(input(workspace))).rejects.toMatchObject({ code: "WORKSPACE_QUERY_CLOSED" });
      await Promise.allSettled(tracked);
      expect(writes).toBe(0);
    } finally { db.close(); }
  });

  it("settles the original tracked request when tracking rejects admission", async () => {
    let original: Promise<unknown> | undefined;
    const service = createManagedWorkspaceQuery({
      journal: { save: () => { throw new Error("must not write"); } }, context: () => context,
      assertActive: () => { throw new Error("must not start"); }, privateRoots: [privateRoot],
      trackOperation: work => { original = work; throw new Error("admission closed"); },
    });
    const request = service.readOnlyGit(input(workspace));
    expect(request).toBe(original);
    await expect(request).rejects.toThrow("admission closed");
    await expect(original).rejects.toThrow("admission closed");
    expect(await service.drain()).toMatchObject({ clean: true });
  });

  it("fences an already queued preparation/request when sealed", async () => {
    let writes = 0;
    const service = createManagedWorkspaceQuery({ journal: { save: () => { writes++; } }, context: () => context,
      assertActive: () => {}, privateRoots: [privateRoot], gitExecutable: git });
    const preparing = service.prepare();
    service.seal();
    expect(await preparing).toMatchObject({ ready: false, code: "WORKSPACE_QUERY_CLOSED" });
    await expect(service.readOnlyGit(input(workspace))).rejects.toMatchObject({ code: "WORKSPACE_QUERY_CLOSED" });
    expect(writes).toBe(0);
  });

  it("runs a real bounded query only through an injected proven executor with stop evidence", async () => {
    await run(git, ["init", "-q", workspace]);
    const runner = createFixtureManagedGitRunner({ privateRoots: [privateRoot] });
    try {
      const service = createManagedWorkspaceQuery({ journal: { save: () => {} }, context: () => context,
        assertActive: () => {}, privateRoots: [privateRoot], gitExecutable: git, executor: runner.workspaceQueryPort() });
      await expect(service.prepare()).resolves.toMatchObject({ ready: true, platform: process.platform });
      const toplevel = await service.readOnlyGit(input(workspace));
      expect(toplevel.stdout.trim()).toBe(workspace);
      const common = await service.readOnlyGit(input(workspace, true));
      expect(common.stdout.trim()).toBe(join(workspace, ".git"));
      expect(await service.drain()).toEqual({ closed: true, producerStopped: true, clean: true });
      expect((await runner.closeAndWait(1_000)).producerStopped).toBe(true);
    } finally {
      await runner.closeAndWait(1_000);
      runner.sealJournal();
    }
  });

  it.runIf(process.platform === "darwin")("rebuilds only the exact bounded rev-parse plans with a controlled environment", () => {
    for (const common of [false, true]) {
      const plan = planManagedWorkspaceQuery(input(workspace, common), { privateRoots: [privateRoot], gitExecutable: git });
      expect(plan.cwd).toBe(workspace);
      expect(plan.argv).toContain("--no-optional-locks");
      expect(plan.argv).toContain("core.hooksPath=/dev/null");
      expect(plan.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "" });
      expect(plan.env).not.toHaveProperty("HOME");
      expect(plan.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.argv)).toBe(true);
    }
  });

  it.each([
    ["rev-parse", "--show-toplevel", "--git-dir"],
    ["rev-parse", "--git-common-dir"],
    ["status", "--porcelain"],
    ["fetch", "origin"],
    ["-c", "core.fsmonitor=malicious", "rev-parse", "--show-toplevel"],
    ["rev-parse", "--show-toplevel", "--output=/private/query"],
  ])("rejects argv outside the existing query seam: %j", (...suffix) => {
    const request = input(workspace);
    request.argv = ["-c", "core.fsmonitor=false", "-C", workspace, ...suffix];
    expect(() => planManagedWorkspaceQuery(request, { privateRoots: [privateRoot] })).toThrow("WORKSPACE_QUERY_INPUT_INVALID");
  });

  it("rejects expanded bounds and private-overlapping roots before executable selection", () => {
    for (const changed of [{ maxBufferBytes: 16 * 1024 + 1 }, { timeoutMs: 5_001 }, { timeoutMs: 0 }]) {
      expect(() => planManagedWorkspaceQuery({ ...input(workspace), ...changed }, { privateRoots: [privateRoot] })).toThrow("WORKSPACE_QUERY_INPUT_INVALID");
    }
    expect(() => planManagedWorkspaceQuery(input(privateRoot), { privateRoots: [privateRoot] })).toThrow("WORKSPACE_QUERY_INPUT_INVALID");
    expect(() => planManagedWorkspaceQuery(input(root), { privateRoots: [privateRoot] })).toThrow("WORKSPACE_QUERY_INPUT_INVALID");
  });
});

const ADVERSARY = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <bsm/libbsm.h>
extern char **environ;
static int denied(const char *path, int flags) {
  int fd=open(path,flags,0600);
  if(fd>=0){close(fd);return 0;}
  return errno==EPERM||errno==EACCES;
}
static void identity(const char *phase) {
  audit_token_t token; mach_msg_type_number_t count=TASK_AUDIT_TOKEN_COUNT;
  kern_return_t rc=task_info(mach_task_self(),TASK_AUDIT_TOKEN,(task_info_t)&token,&count);
  char boot[128]={0};size_t size=sizeof boot;
  int sysctl_result=sysctlbyname("kern.bootsessionuuid",boot,&size,NULL,0);
  printf("{\"phase\":\"%s\",\"pid\":%d,\"auditPid\":%d,\"pidVersion\":%d,\"taskInfoResult\":%d,\"bootResult\":%d,\"bootUUID\":\"%s\"}\n",
    phase,getpid(),rc==KERN_SUCCESS?audit_token_to_pid(token):-1,rc==KERN_SUCCESS?audit_token_to_pidversion(token):-1,rc,sysctl_result,boot);
}
int main(int argc,char **argv) {
  alarm(5);setvbuf(stdout,NULL,_IONBF,0);
  if(argc<2)return 64;
  if(!strcmp(argv[1],"leaf"))return 0;
  if(!strcmp(argv[1],"after-exec")){identity("after");return 0;}
  if(!strcmp(argv[1],"identity-exec")){
    identity("before");char *args[]={argv[0],"after-exec",NULL};execve(argv[0],args,environ);return 65;
  }
  if(argc<5)return 64;
  errno=0;pid_t child=fork();int fork_errno=child<0?errno:0;
  if(child==0)_exit(0);if(child>0)waitpid(child,NULL,0);
  posix_spawnattr_t attributes;posix_spawnattr_init(&attributes);posix_spawnattr_setflags(&attributes,POSIX_SPAWN_SETSID);
  char *args[]={argv[0],"leaf",NULL};pid_t spawned;
  int spawn_errno=posix_spawn(&spawned,argv[0],NULL,&attributes,args,environ);posix_spawnattr_destroy(&attributes);
  if(!spawn_errno)waitpid(spawned,NULL,0);
  int nullfd=open("/dev/null",O_RDWR);int null_sink=nullfd>=0;if(nullfd>=0)close(nullfd);
  int fd=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_port=htons(0);address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  errno=0;int connected=fd<0?-1:connect(fd,(struct sockaddr*)&address,sizeof address);
  int network_errno=errno;if(fd>=0)close(fd);
  printf("{\"forkErrno\":%d,\"spawnErrno\":%d,\"privateReadDenied\":%s,\"aliasReadDenied\":%s,\"privateWriteDenied\":%s,\"workspaceWriteDenied\":%s,\"networkDenied\":%s,\"nullSinkAllowed\":%s}\n",
    fork_errno,spawn_errno,denied(argv[2],O_RDONLY)?"true":"false",denied(argv[3],O_RDONLY)?"true":"false",
    denied(argv[2],O_WRONLY|O_TRUNC)?"true":"false",denied(argv[4],O_WRONLY|O_CREAT|O_TRUNC)?"true":"false",
    connected<0&&(network_errno==EPERM||network_errno==EACCES)?"true":"false",null_sink?"true":"false");
  return 0;
}
`;

describe.runIf(process.platform === "darwin")("actual helper-only macOS policy; no production identity promotion", () => {
  let root: string, workspace: string, privateRoot: string, privateFile: string, alias: string;
  let helper: string, profile: string, profileDigest: string;
  let db: Database.Database;
  const registries: ManagedProcessRegistry[] = [];
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "flyx-query-os-")));
    workspace = join(root, "checkout space-雪");privateRoot = join(root, "host-private");
    await Promise.all([workspace,privateRoot].map(path=>mkdir(path,{mode:0o700})));
    privateFile=join(privateRoot,"sentinel");alias=join(workspace,"private-alias");
    await writeFile(privateFile,"fixture-private",{mode:0o600});await symlink(privateFile,alias);
    helper=join(root,"probe");const source=join(root,"probe.c");
    await writeFile(source,ADVERSARY,{mode:0o600});
    await run("/usr/bin/xcrun",["clang","-std=c11","-Wall","-Wextra","-Werror","-D_DARWIN_C_SOURCE",source,"-lbsm","-o",helper],{timeout:20_000,maxBuffer:32*1024});
    const metadata=join(workspace,".git");
    await mkdir(join(metadata,"objects"),{recursive:true});await mkdir(join(metadata,"refs","heads"),{recursive:true});
    await writeFile(join(metadata,"HEAD"),"ref: refs/heads/main\n");
    await writeFile(join(metadata,"config"),'[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = /malicious-child-tool\nhooksPath = /malicious-hooks\n[alias]\nrev-parse = !touch /malicious-write\n');
    profile=join(root,"readonly.sb");
    const policy=macosWorkspaceQueryReadOnlyProfile({privateRoots:[privateRoot],executables:[helper,git]});
    profileDigest=createHash("sha256").update(policy).digest("hex");await writeFile(profile,policy,{mode:0o600});
    db=new Database(":memory:");db.exec(MANAGED_PROCESS_SCHEMA+MANAGED_PROCESS_IDENTITY_SCHEMA);
  },30_000);
  afterAll(async () => {
    for(const registry of registries){await registry.closeAndWait(100);registry.sealJournal();}
    db?.close();await rm(root,{recursive:true,force:true});
  });

  async function capture(command:string,args:readonly string[],cwd=workspace,env:NodeJS.ProcessEnv={}):Promise<{stdout:string;records:ManagedProcessRecord[]}> {
    const registry=new ManagedProcessRegistry({journal:new SqliteProcessJournal(db),context:()=>({...context,attemptId:"diagnostic-"+registries.length})});
    registries.push(registry);
    const launchDigest=createHash("sha256").update(JSON.stringify({command,args,cwd,env})).digest("hex");
    const child:ChildProcess=registry.spawn(command,args,{cwd,env,stdio:["ignore","pipe","pipe"]},{
      proof:{kind:"workspace-git-readonly-policy-diagnostic",policyDigest:profileDigest,verifiedStableProcessBirth:false},launchDigest,
    });
    let stdout="",stderr="";
    const finished=new Promise<void>((resolve,reject)=>{
      child.stdout?.on("data",(data:Buffer)=>{stdout+=data.toString("utf8");if(Buffer.byteLength(stdout)>32*1024){child.kill("SIGKILL");reject(new Error("output exceeded"));}});
      child.stderr?.on("data",(data:Buffer)=>{stderr+=data.toString("utf8");});
      child.once("error",reject);child.once("close",code=>code===0?resolve():reject(new Error("probe exit "+code+": "+stderr)));
    });
    const watchdog=setTimeout(()=>child.kill("SIGKILL"),8_000);
    try {await finished;} finally {clearTimeout(watchdog);}
    expect((await registry.closeAndWait(0)).treeStopped).toBe(false);
    const records=registry.records();expect(records[0]?.state).toBe("unknown");expect(records[0]?.stopProof).toBeUndefined();
    const stored=db.prepare("SELECT proof_json,launch_digest FROM managed_process_boundaries WHERE process_id=?").get(records[0]!.id) as {proof_json:string;launch_digest:string};
    expect(stored.launch_digest).toBe(launchDigest);expect(JSON.parse(stored.proof_json)).toMatchObject({policyDigest:profileDigest,verifiedStableProcessBirth:false});
    return {stdout,records};
  }

  it("denies fork, POSIX_SPAWN_SETSID, private aliases, all writes, and network connect",async()=>{
    const result=await capture("/usr/bin/sandbox-exec",["-f",profile,"--",helper,"probe",privateFile,alias,join(workspace,"write-attempt")]);
    expect(JSON.parse(result.stdout)).toEqual({forkErrno:1,spawnErrno:1,privateReadDenied:true,aliasReadDenied:true,privateWriteDenied:true,workspaceWriteDenied:true,networkDenied:true,nullSinkAllowed:true});
    expect(await readFile(privateFile,"utf8")).toBe("fixture-private");
  });

  it.each([false,true])("runs actual allowlisted Git in an unborn Unicode/space checkout (common=%s)",async common=>{
    const plan=planManagedWorkspaceQuery(input(workspace,common),{privateRoots:[privateRoot],gitExecutable:git});
    const result=await capture("/usr/bin/sandbox-exec",["-f",profile,"--",plan.command,...plan.argv],plan.cwd,{...plan.env});
    expect(result.stdout.trim()).toBe(common?join(workspace,".git"):workspace);
    expect(await readFile(join(workspace,".git","HEAD"),"utf8")).toBe("ref: refs/heads/main\n");
  });

  it("records real kernel audit identity but rejects its changing exec version as stable birth",async()=>{
    const result=await capture("/usr/bin/sandbox-exec",["-f",profile,"--",helper,"identity-exec"]);
    const [before,after]=result.stdout.trim().split("\n").map(line=>JSON.parse(line) as {phase:string;pid:number;auditPid:number;pidVersion:number;taskInfoResult:number;bootResult:number;bootUUID:string});
    expect(before).toMatchObject({phase:"before",taskInfoResult:0,bootResult:0});expect(after).toMatchObject({phase:"after",taskInfoResult:0,bootResult:0});
    expect(before!.pid).toBe(before!.auditPid);expect(after!.pid).toBe(before!.pid);expect(after!.auditPid).toBe(before!.pid);
    expect(before!.pidVersion).toBeGreaterThan(0);expect(after!.pidVersion).not.toBe(before!.pidVersion);
    expect(before!.bootUUID).toMatch(/^[a-f0-9-]{36}$/i);expect(after!.bootUUID).toBe(before!.bootUUID);
    expect(result.records[0]!.processIdentity?.birth).toBeUndefined();
  });
});

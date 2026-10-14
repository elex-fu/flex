import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CheckpointError } from "./types.js";
import { RevertCrash } from "./revert-types.js";
import type { NativeRevertProof } from "./revert-types.js";
import { bindingDigest } from "./git-driver.js";
import { revertFixture, stageRaw } from "./revert-test-support.js";
import { fixtureGit, userGitState } from "./test-support.js";

const fixtures:Awaited<ReturnType<typeof revertFixture>>[]=[];
afterEach(async()=>{for(const fixture of fixtures.splice(0)){await fixture.revert.drain(20);if(fixture.owner.db.open)fixture.owner.close();await rm(fixture.root,{recursive:true,force:true});}});
async function fixture(options:Parameters<typeof revertFixture>[0]={}){const value=await revertFixture(options);fixtures.push(value);return value;}

// These cases create several real Git repositories and invoke isolated raw
// restore helpers. Keep their test budget separate from injected fault deadlines.
describe("durable controlled revert",{timeout:20_000},()=>{
  it("atomically accepts plan, receipt, immutable intent, journal and blocking gate",async()=>{
    const f=await fixture();const revision=f.resolve().sessionRevision;const operation=await f.accept("revert","accept-1");
    expect(f.store.getPreview(f.page.planId,f.context.sessionId,"device-1").state).toBe("consumed");
    expect(f.owner.getCommandReceipt("device-1","accept-1")?.state).toBe("accepted");
    const intent=f.owner.db.prepare("SELECT dispatch_context_json FROM execution_intents WHERE resource_id=?").get(operation.operationId) as {dispatch_context_json:string};
    expect(JSON.parse(intent.dispatch_context_json).flyxTurnId).toBe(operation.operationId);
    expect(f.owner.getSession(f.context.sessionId)?.revision).toBe(revision+1);expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");
    expect(f.newTurn).toThrow("RECOVERY_BLOCKED");expect((await f.accept("revert","accept-1")).operationId).toBe(operation.operationId);
  });
  it("rolls back every acceptance fact on journal SQL failure before external writes",async()=>{
    const f=await fixture();const before=await userGitState(f.root);const revision=f.resolve().sessionRevision;
    f.owner.db.exec("CREATE TEMP TRIGGER fail_accept BEFORE INSERT ON checkpoint_revert_operations BEGIN SELECT RAISE(ABORT,'accept failure'); END");
    await expect(f.accept("revert","sql-fail")).rejects.toThrow("accept failure");
    expect(f.owner.getCommandReceipt("device-1","sql-fail")).toBeUndefined();expect(f.store.getPreview(f.page.planId,f.context.sessionId,"device-1").state).toBe("active");
    expect(f.owner.getSession(f.context.sessionId)?.revision).toBe(revision);expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");
    expect(await userGitState(f.root)).toEqual(before);expect(f.native.calls).toHaveLength(0);
  });
  it("restores exact workspace and independent index, retains HEAD/events/receipts, and commits a new epoch",async()=>{
    const f=await fixture();const before=await userGitState(f.root);const operation=await f.accept("revert","complete-1");
    const result=await f.dispatch(operation.operationId);expect(result.status).toBe("settled");
    expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("target-workspace\n");
    expect((await fixtureGit(f.root,["show",":tracked.txt"])).toString()).toBe("target-index\n");
    const after=await userGitState(f.root);expect(after.head).toBe(before.head);expect(after.branch).toBe(before.branch);
    expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");expect(f.owner.getCommandReceipt("device-1","complete-1")?.state).toBe("completed");
    expect(f.resolve().epoch).not.toBe("epoch-1");expect(f.owner.db.prepare("SELECT COUNT(*) n FROM checkpoint_revert_view_boundaries").get()).toEqual({n:1});
    expect((f.owner.db.prepare("SELECT type FROM session_events WHERE session_id=?").all(f.context.sessionId) as Array<{type:string}>).some((event)=>event.type==="checkpoint.revert.accepted")).toBe(true);
    const journal=f.revert.store.require(operation.operationId,f.context.sessionId);expect(journal.steps.every((step)=>step.state==="applied")).toBe(true);
    expect(f.store.protectedRefs().some((item)=>item.checkpointId===journal.safetyCheckpointId)).toBe(true);expect(f.newTurn()).toBeDefined();
  });
  it("refuses stale/expired previews, wrong actor/native/epoch, and changed index after acceptance",async()=>{
    const f=await fixture();await writeFile(join(f.root,"tracked.txt"),"external edit\n");await expect(f.accept()).rejects.toThrow("Workspace, index or HEAD changed");
    const g=await fixture();g.advance(300_000);await expect(g.accept()).rejects.toThrow("expired");
    const h=await fixture();await expect(h.revert.accept({sessionId:h.context.sessionId,actorId:"other",commandId:"bad",planId:h.page.planId,expectedSessionRevision:h.page.expectedSessionRevision,mode:"revert",confirmation:true})).rejects.toThrow("another actor");
    const j=await fixture();const operation=await j.accept();await stageRaw(j.root,"tracked.txt","intervening-index\n");const result=await j.dispatch(operation.operationId);
    expect(result.resultCode).toBe("PLAN_STALE");expect(j.native.calls).toHaveLength(0);expect(j.newTurn).toThrow("RECOVERY_BLOCKED");
  });
  it("requires trusted lease succession and rejects any intervening Session writer",async()=>{
    const f=await fixture();const operation=await f.accept();f.setLease({workspaceId:"default",leaseId:"new-fence",generation:2});
    const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("PLAN_STALE");expect(f.native.calls).toHaveLength(0);
    const g=await fixture();const accepted=await g.accept();g.owner.commitEvent(g.context.sessionId,"external.changed",{});
    expect((await g.dispatch(accepted.operationId)).resultCode).toBe("PLAN_STALE");expect(g.native.calls).toHaveLength(0);
  });
  it("keeps native timeout unknown; late completion never silently clears the gate or replays",async()=>{
    const f=await fixture();f.restart({nativeTimeoutMs:5});let finish!:(proof:NativeRevertProof)=>void;
    f.native.applyOverride=async(request)=>{const proof=f.native.proof(request,"unknown",true);f.native.states.set(request.requestId,proof);return new Promise((resolve)=>{finish=resolve;});};
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("NATIVE_OUTCOME_UNKNOWN");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    const pending=await f.inspect(operation.operationId);expect(pending.resumable).toBe(false);expect(await f.revert.drain(1)).toBe(false);
    const request=f.native.calls[0]!;const proof=f.native.proof(request);f.native.states.set(request.requestId,proof);finish(proof);await f.revert.drain(100);
    expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");expect(f.native.calls).toHaveLength(1);
    f.restart();const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");expect(f.native.calls).toHaveLength(1);
  });
  it("rejects stale recovery evidence and unrelated recovery ownership",async()=>{
    let crash=true;const f=await fixture({boundary:(boundary)=>{if(boundary==="workspace_restored" && crash){crash=false;throw new RevertCrash(boundary);}}});
    const operation=await f.accept();await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);f.restart({onBoundary:()=>{}});
    const evidence=await f.inspect(operation.operationId);await writeFile(join(f.root,"unrelated.txt"),"external\n");
    await expect(f.revert.resumeVerified({sessionId:f.context.sessionId,actorId:"device-1",operationId:operation.operationId,commandId:"resume-stale",evidenceId:evidence.evidenceId,expectedSessionRevision:evidence.expectedSessionRevision,confirmation:true})).rejects.toThrow("Workspace changed");
    f.owner.db.prepare("UPDATE sessions SET recovery_revision=recovery_revision+1 WHERE id=?").run(f.context.sessionId);
    await expect(f.inspect(operation.operationId)).rejects.toThrow("exact recovery gate");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  });
  it("reports workspaceRestore and new conversation explicitly for an unsupported Provider",async()=>{
    const f=await fixture();f.native.supported=false;await expect(f.accept()).rejects.toThrow("workspaceRestore");
    const operation=await f.accept("workspaceRestore");const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("NEW_CONVERSATION_REQUIRED");
    expect(result.result.mode).toBe("workspaceRestore");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("target-workspace\n");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    f.native.supported=true;const resumed=await f.resume(operation.operationId);const completed=await f.dispatch(resumed.operationId);expect(completed.status).toBe("settled");expect(f.native.calls[0]?.mode).toBe("workspaceRestore");
  });
  it("rolls back failed final SQL including epoch/native adoption and never reports ready",async()=>{
    const f=await fixture();f.owner.db.exec("CREATE TEMP TRIGGER fail_final BEFORE INSERT ON checkpoint_revert_view_boundaries BEGIN SELECT RAISE(ABORT,'final failure'); END");
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.status).toBe("outcome_unknown");expect(f.resolve().epoch).toBe("epoch-1");
    expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");expect(f.native.calls).toHaveLength(1);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    f.owner.db.exec("DROP TRIGGER fail_final");const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");expect(f.native.calls).toHaveLength(1);
  });
  it("captures disk/permission failure after marker and retains recoverable safety refs",async()=>{
    for(const failure of ["disk_full","permission_denied"] as const){const f=await fixture({restore:{fault:(step)=>step.kind==="workspace_file"?failure:undefined}});const operation=await f.accept();
      const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe(failure==="disk_full"?"RESTORE_DISK_FULL":"RESTORE_PERMISSION_DENIED");
      const journal=f.revert.store.require(operation.operationId,f.context.sessionId);expect(journal.safetyCheckpointId).toBeDefined();expect(journal.steps.some((step)=>step.state==="outcome_unknown")).toBe(true);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");}
  });
  it("detects a file race at dispatch and preserves the external content",async()=>{
    const f=await fixture({boundary:async(boundary)=>{if(boundary==="workspace_file.dispatch")await writeFile(join(f.root,"tracked.txt"),"racing editor\n");}});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("FILE_COLLISION");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("racing editor\n");expect(f.native.calls).toHaveLength(0);
  });
  it("reconciles a half-written owned temp only after explicit fresh evidence",async()=>{
    let fail=true;const f=await fixture({restore:{fault:(step)=>step.kind==="workspace_file" && fail?(fail=false,"half_write"):undefined}});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("INJECTED_HALF_WRITE");
    expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");expect((await readdir(f.root)).some((name)=>name.startsWith(".flyx-revert-"))).toBe(true);
    f.restart();const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");
    expect((await readdir(f.root)).some((name)=>name.startsWith(".flyx-revert-"))).toBe(false);
    const step=f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((item)=>item.kind==="workspace_file")!;expect(step.attempts).toHaveLength(2);expect(step.attempts[0]?.state).toBe("outcome_unknown");
  });
  it("preserves a foreign index.lock and blocks index collision",async()=>{
    const f=await fixture({boundary:async(boundary)=>{if(boundary==="index.dispatch")await writeFile(join(f.root,".git/index.lock"),"foreign-lock");}});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.status).toBe("outcome_unknown");expect(await readFile(join(f.root,".git/index.lock"),"utf8")).toBe("foreign-lock");expect(f.native.calls).toHaveLength(0);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  });
});


describe("raw restore and safety rollback",()=>{
  it("restores binary, executable, symlink, rename and new parents without filters or hooks",async()=>{
    const f=await fixture({setup:async(root)=>{
      await writeFile(join(root,"binary.bin"),Buffer.from([0,1,2,255]));await stageRaw(root,"binary.bin",Buffer.from([0,3,9,255]));
      await writeFile(join(root,"execute.sh"),"target script\n");await chmod(join(root,"execute.sh"),0o755);await stageRaw(root,"execute.sh","target staged script\n","100755");
      await symlink("tracked.txt",join(root,"link"));await stageRaw(root,"link","tracked.txt","120000");
      await mkdir(join(root,"nested"));await writeFile(join(root,"nested/new.txt"),"target nested\n");
      await writeFile(join(root,"old name.txt"),"target rename\n");await stageRaw(root,"old name.txt","target rename\n");
      await writeFile(join(root,".gitignore"),"ignored-*\n");await writeFile(join(root,"ignored-private.txt"),"keep ignored\n");
      await writeFile(join(root,".gitattributes"),"* filter=evil diff=evil\n");
      await fixtureGit(root,["config","filter.evil.clean",`sh -c 'printf executed > "${join(root,"ignored-filter-ran")}"'`]);await fixtureGit(root,["config","filter.evil.required","true"]);
      await fixtureGit(root,["config","diff.evil.command",`sh -c 'printf executed > "${join(root,"ignored-diff-ran")}"'`]);
    },afterTarget:async(root)=>{
      await writeFile(join(root,"binary.bin"),Buffer.from([0,77,12]));await stageRaw(root,"binary.bin",Buffer.from([0,81,12]));
      await writeFile(join(root,"execute.sh"),"current script\n");await chmod(join(root,"execute.sh"),0o644);await stageRaw(root,"execute.sh","current staged script\n");
      await rm(join(root,"link"));await symlink("other-target",join(root,"link"));await stageRaw(root,"link","other-target","120000");
      await rm(join(root,"nested"),{recursive:true});await rename(join(root,"old name.txt"),join(root,"new name.txt"));await fixtureGit(root,["update-index","--remove","--","old name.txt"]);await stageRaw(root,"new name.txt","target rename\n");
      await writeFile(join(root,"new-current-only.txt"),"planned deletion\n");
    }});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.status).toBe("settled");
    expect(await readFile(join(f.root,"binary.bin"))).toEqual(Buffer.from([0,1,2,255]));expect((await fixtureGit(f.root,["show",":binary.bin"]))).toEqual(Buffer.from([0,3,9,255]));
    const {lstat,readlink}=await import("node:fs/promises");expect((await lstat(join(f.root,"execute.sh"))).mode&0o111).not.toBe(0);expect(await readlink(join(f.root,"link"))).toBe("tracked.txt");
    expect(await readFile(join(f.root,"nested/new.txt"),"utf8")).toBe("target nested\n");expect(await readFile(join(f.root,"old name.txt"),"utf8")).toBe("target rename\n");
    await expect(readFile(join(f.root,"new name.txt"))).rejects.toThrow();await expect(readFile(join(f.root,"new-current-only.txt"))).rejects.toThrow();
    expect(await readFile(join(f.root,"ignored-private.txt"),"utf8")).toBe("keep ignored\n");await expect(readFile(join(f.root,"ignored-filter-ran"))).rejects.toThrow();await expect(readFile(join(f.root,"ignored-diff-ran"))).rejects.toThrow();
  },30_000);
  it("keeps a symlink parent race contained and leaves external files untouched",async()=>{
    let root="";const f=await fixture({setup:async(value)=>{root=value;await mkdir(join(value,"inside"));await writeFile(join(value,"inside/target.txt"),"target\n");},afterTarget:async(value)=>{await writeFile(join(value,"inside/target.txt"),"current\n");},
      boundary:async(boundary,_operation,step)=>{if(boundary==="workspace_file.dispatch" && step?.path==="inside/target.txt"){
        await mkdir(join(root,"ignored-outside"));await writeFile(join(root,"ignored-outside/target.txt"),"external\n");await rename(join(root,"inside"),join(root,"original-parent"));await symlink(join(root,"ignored-outside"),join(root,"inside"));
      }}});
    const operation=await f.accept();expect((await f.dispatch(operation.operationId)).status).toBe("outcome_unknown");expect(await readFile(join(f.root,"ignored-outside/target.txt"),"utf8")).toBe("external\n");expect(f.native.calls).toHaveLength(0);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  },20_000);
  it.each(["workspace_file","index"] as const)("reconciles %s crash after atomic replacement and removes only owned artifacts",async(kind)=>{
    let fault=true;const f=await fixture({restore:{fault:(step)=>step.kind===kind && fault?(fault=false,"after_replace"):undefined}});
    const operation=await f.accept();expect((await f.dispatch(operation.operationId)).resultCode).toBe("INJECTED_AFTER_REPLACE");
    f.restart();const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");
    expect((await readdir(f.root)).some((name)=>name.startsWith(".flyx-revert-"))).toBe(false);expect((await readdir(join(f.root,".git"))).some((name)=>name.startsWith(".flyx-revert-") || name==="index.lock")).toBe(false);
  },20_000);
  it("rejects corrupt owned temp evidence and never deletes a same-name foreign file",async()=>{
    let fault=true;const f=await fixture({restore:{fault:(step)=>step.kind==="workspace_file" && fault?(fault=false,"half_write"):undefined}});
    const operation=await f.accept();await f.dispatch(operation.operationId);const step=f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((item)=>item.kind==="workspace_file")!;
    const temporary=join(f.root,`.flyx-revert-${step.stepId}.tmp`);await writeFile(temporary,"foreign contents\n");
    const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).resultCode).toBe("RESTORE_ARTIFACT_COLLISION");expect(await readFile(temporary,"utf8")).toBe("foreign contents\n");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  },20_000);
  it("journals safety rollback and preserves unrelated untracked/ignored files created after failure",async()=>{
    let crash=true;const f=await fixture({setup:async(root)=>{await writeFile(join(root,".gitignore"),"ignored-*\n");},boundary:(boundary)=>{if(boundary==="workspace_restored" && crash){crash=false;throw new RevertCrash(boundary);}}});
    const before=await userGitState(f.root);const operation=await f.accept();await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    await writeFile(join(f.root,"late-untracked.txt"),"preserve late\n");await writeFile(join(f.root,"ignored-private.txt"),"preserve ignored\n");f.restart({onBoundary:()=>{}});
    const rollback=await f.rollback(operation.operationId);expect(rollback.parentOperationId).toBe(operation.operationId);expect((await f.dispatch(rollback.operationId)).status).toBe("settled");
    expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");expect((await fixtureGit(f.root,["show",":tracked.txt"])).toString()).toBe("current-index\n");
    expect(await readFile(join(f.root,"late-untracked.txt"),"utf8")).toBe("preserve late\n");expect(await readFile(join(f.root,"ignored-private.txt"),"utf8")).toBe("preserve ignored\n");
    expect((await userGitState(f.root)).head).toBe(before.head);expect(f.revert.store.require(operation.operationId,f.context.sessionId).status).toBe("rolled_back");expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");
  },20_000);
  it("cleans original half-write artifacts through separately marked safety rollback actions",async()=>{
    let fault=true;const f=await fixture({restore:{fault:(step)=>step.kind==="workspace_file" && fault?(fault=false,"half_write"):undefined}});
    const operation=await f.accept();await f.dispatch(operation.operationId);f.restart();const rollback=await f.rollback(operation.operationId);
    const result=await f.dispatch(rollback.operationId);expect(result.status).toBe("settled");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");
    expect((await readdir(f.root)).some((name)=>name.startsWith(".flyx-revert-"))).toBe(false);
    const cleanup=f.revert.store.require(rollback.operationId,f.context.sessionId).steps.find((step)=>step.kind==="owned_cleanup")!;expect(cleanup.state).toBe("applied");expect(cleanup.attempts[0]?.state).toBe("applied");
  },20_000);
  it("requires original writer stop proof and fresh evidence expiry",async()=>{
    let crash=true;const f=await fixture({boundary:(boundary)=>{if(boundary==="validated" && crash){crash=false;throw new RevertCrash(boundary);}}});
    const operation=await f.accept();await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);f.restart({onBoundary:()=>{}});f.setQuiescent(false);
    await expect(f.inspect(operation.operationId)).rejects.toThrow("proven stopped");f.setQuiescent(true);const evidence=await f.inspect(operation.operationId);f.advance(30_000);
    await expect(f.revert.resumeVerified({sessionId:f.context.sessionId,actorId:"device-1",operationId:operation.operationId,commandId:"expired-evidence",evidenceId:evidence.evidenceId,expectedSessionRevision:evidence.expectedSessionRevision,confirmation:true})).rejects.toThrow("expired");expect(f.native.calls).toHaveLength(0);
  },20_000);
  it("revalidates actor inside dispatch-marker commit and never writes after revocation",async()=>{
    let f!:Awaited<ReturnType<typeof fixture>>;f=await fixture({boundary:(boundary)=>{if(boundary==="safety_captured")f.setActorAllowed(false);}});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.status).toBe("outcome_unknown");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");expect(f.native.calls).toHaveLength(0);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  },20_000);
});


describe("restart durability and SQL action boundaries",()=>{
  it("reopens the actual SQLite file after an unknown external write and retains immutable facts",async()=>{
    let crash=true;const f=await fixture({persistent:true,boundary:(boundary)=>{if(boundary==="workspace_file.external" && crash){crash=false;throw new RevertCrash(boundary);}}});
    const operation=await f.accept("revert","persistent-command");await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    const marker=f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.kind==="workspace_file")!;expect(marker.state).toBe("dispatching");f.reopen();f.restart({onBoundary:()=>{}});
    expect(f.owner.getCommandReceipt("device-1","persistent-command")?.state).toBe("accepted");expect(f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.stepId===marker.stepId)?.state).toBe("dispatching");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");expect(f.native.calls).toHaveLength(1);
    expect(f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.stepId===marker.stepId)?.attempts).toHaveLength(1);
  },20_000);
  it("records an unknown file write if its result SQL commit fails, then resolves without re-writing it",async()=>{
    const f=await fixture();f.owner.db.exec("CREATE TEMP TRIGGER fail_action BEFORE UPDATE ON checkpoint_revert_steps WHEN NEW.kind='workspace_file' AND NEW.state='applied' BEGIN SELECT RAISE(ABORT,'action failure'); END");
    const operation=await f.accept();expect((await f.dispatch(operation.operationId)).status).toBe("outcome_unknown");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("target-workspace\n");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    const attempts=f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.kind==="workspace_file")!.attempts.length;
    f.owner.db.exec("DROP TRIGGER fail_action");const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");
    expect(f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.kind==="workspace_file")!.attempts).toHaveLength(attempts);
  },20_000);
  it("does not clear a gate during an actual async barrier and keeps operation reads responsive",async()=>{
    let release!:()=>void;let reached!:()=>void;const entered=new Promise<void>((resolve)=>{reached=resolve;});const gate=new Promise<void>((resolve)=>{release=resolve;});
    const f=await fixture({boundary:async(boundary)=>{if(boundary==="safety_captured"){reached();await gate;}}});const operation=await f.accept();const running=f.dispatch(operation.operationId);await entered;
    expect(f.revert.getOperation({sessionId:f.context.sessionId,actorId:"device-1",operationId:operation.operationId}).stage).toBe("safety_captured");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    await expect(f.inspect(operation.operationId)).rejects.toThrow("still running");expect(f.native.calls).toHaveLength(0);release();expect((await running).status).toBe("settled");
  },20_000);
  it("blocks an expired accepted operation before safety capture or native dispatch",async()=>{
    const f=await fixture();const operation=await f.accept();f.advance(300_000);const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("PLAN_STALE");
    expect(f.revert.store.require(operation.operationId,f.context.sessionId).safetyCheckpointId).toBeUndefined();expect(f.native.calls).toHaveLength(0);expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
  },20_000);
  it("rechecks native/epoch after acquisition and permits runtime succession only through fresh recovery evidence",async()=>{
    const f=await fixture();f.owner.db.prepare("UPDATE test_active_view SET epoch='external-epoch' WHERE session_id=?").run(f.context.sessionId);await expect(f.accept()).rejects.toThrow("binding changed");expect(f.native.calls).toHaveLength(0);
    const g=await fixture();g.owner.db.prepare("UPDATE test_active_view SET native_json=? WHERE session_id=?").run(JSON.stringify({sessionId:"different-native"}),g.context.sessionId);await expect(g.accept()).rejects.toThrow("binding changed");
    let crash=true;const h=await fixture({boundary:(boundary)=>{if(boundary==="workspace_file.dispatch" && crash){crash=false;throw new RevertCrash(boundary);}}});const operation=await h.accept();await expect(h.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    h.setRuntime(2);h.restart({onBoundary:()=>{}});const resumed=await h.resume(operation.operationId);expect((await h.dispatch(resumed.operationId)).status).toBe("settled");
    const stored=h.revert.store.require(operation.operationId,h.context.sessionId);expect(stored.plan.runtimeGeneration).toBe(1);expect(stored.commands[0]?.dispatchContext.runtimeGeneration).toBe(1);expect(stored.commands[1]?.dispatchContext.runtimeGeneration).toBe(2);
  },25_000);
  it("reconciles a half-written index and journals safety restoration independently of workspace bytes",async()=>{
    let fault=true;const f=await fixture({restore:{fault:(step)=>step.kind==="index" && fault?(fault=false,"half_write"):undefined}});const operation=await f.accept();expect((await f.dispatch(operation.operationId)).resultCode).toBe("INJECTED_HALF_WRITE");
    expect((await fixtureGit(f.root,["show",":tracked.txt"])).toString()).toBe("current-index\n");const rollback=await f.rollback(operation.operationId);expect((await f.dispatch(rollback.operationId)).status).toBe("settled");
    expect((await fixtureGit(f.root,["show",":tracked.txt"])).toString()).toBe("current-index\n");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");
    expect((await readdir(join(f.root,".git"))).some((name)=>name.startsWith(".flyx-revert-") || name==="index.lock")).toBe(false);
  },20_000);
  it.each(["owned_cleanup.dispatch","owned_cleanup.external"])("recovers explicit safety rollback crash at %s",async(boundary)=>{
    let fault=true;const f=await fixture({restore:{fault:(step)=>step.kind==="workspace_file" && fault?(fault=false,"half_write"):undefined}});const operation=await f.accept();await f.dispatch(operation.operationId);
    const rollback=await f.rollback(operation.operationId);let crash=true;f.restart({onBoundary:(current)=>{if(current===boundary && crash){crash=false;throw new RevertCrash(current);}}});await expect(f.dispatch(rollback.operationId)).rejects.toBeInstanceOf(RevertCrash);
    f.restart({onBoundary:()=>{}});const resumed=await f.resume(rollback.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");
  },20_000);
});


describe("sealed publication at shutdown",()=>{
  it("never feeds mutation input or publishes SQL after sealing a helper registration barrier",async()=>{
    let release!:()=>void;let reached!:()=>void;const entered=new Promise<void>((resolve)=>{reached=resolve;});const gate=new Promise<void>((resolve)=>{release=resolve;});
    const f=await fixture({persistent:true,restore:{onSpawn:async()=>{reached();await gate;}}});const operation=await f.accept();const running=f.dispatch(operation.operationId);await entered;
    const marked=f.revert.store.require(operation.operationId,f.context.sessionId);expect(marked.steps.some((step)=>step.kind==="workspace_file" && step.state==="dispatching")).toBe(true);
    const text=await readFile(join(f.root,"tracked.txt"),"utf8");f.revert.seal();f.owner.close();release();expect((await running).resultCode).toBe("REVERT_SEALED");
    expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe(text);expect(f.native.calls).toHaveLength(0);
    f.reopen();f.restart({restore:new (await import("./controlled-restore.js")).ControlledRestore(),onBoundary:()=>{}});expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");
    const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");
  },20_000);
  it("does not publish a late native result after shared Store close; recovery queries the original token",async()=>{
    let release!:(proof:NativeRevertProof)=>void;let reached!:()=>void;const entered=new Promise<void>((resolve)=>{reached=resolve;});const f=await fixture({persistent:true});
    f.native.applyOverride=async(request)=>{f.native.states.set(request.requestId,f.native.proof(request,"unknown",true));reached();return new Promise((resolve)=>{release=resolve;});};
    const operation=await f.accept();const running=f.dispatch(operation.operationId);await entered;const request=f.native.calls[0]!;
    f.revert.seal();f.owner.close();const proof=f.native.proof(request);f.native.states.set(request.requestId,proof);release(proof);expect((await running).resultCode).toBe("REVERT_SEALED");
    f.reopen();f.restart({restore:new (await import("./controlled-restore.js")).ControlledRestore(),onBoundary:()=>{}});
    expect(f.resolve().epoch).toBe("epoch-1");expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");expect(f.revert.store.require(operation.operationId,f.context.sessionId).steps.find((step)=>step.kind==="provider")?.state).toBe("dispatching");
    const resumed=await f.resume(operation.operationId);expect((await f.dispatch(resumed.operationId)).status).toBe("settled");expect(f.native.calls).toHaveLength(1);
  },20_000);
});


it("rejects Promise actor validation inside the atomic acceptance transaction",async()=>{
 const f=await fixture();f.restart({revalidateActorInCommit:async()=>{}});const revision=f.resolve().sessionRevision;
 await expect(f.accept("revert","async-actor")).rejects.toThrow("share the SQL boundary");expect(f.owner.getCommandReceipt("device-1","async-actor")).toBeUndefined();expect(f.resolve().sessionRevision).toBe(revision);expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");expect(f.native.calls).toHaveLength(0);
},15_000);


describe("restore readiness remains a separate write gate",()=>{
  it("joins the R15 readiness guard to atomic acceptance and leaves all command facts absent",async()=>{
    const f=await fixture();f.owner.db.exec("CREATE TABLE restore_readiness(id TEXT PRIMARY KEY);INSERT INTO restore_readiness VALUES('restored-host')");
    f.restart({assertRestoreWriteReady:(db)=>{expect(db.inTransaction).toBe(true);if(db.prepare("SELECT 1 FROM restore_readiness LIMIT 1").get())throw new CheckpointError("RESTORE_WRITE_BLOCKED","Restored facts require verification");}});
    const revision=f.resolve().sessionRevision;await expect(f.accept("revert","restore-blocked")).rejects.toThrow("require verification");
    expect(f.owner.getCommandReceipt("device-1","restore-blocked")).toBeUndefined();expect(f.store.getPreview(f.page.planId,f.context.sessionId,"device-1").state).toBe("active");expect(f.resolve().sessionRevision).toBe(revision);expect(f.native.calls).toHaveLength(0);
  },15_000);
  it.each(["validated","workspace_restored","projection.dispatch"])("blocks the next external/final dispatch when restore readiness appears at %s",async(boundary)=>{
    let f!:Awaited<ReturnType<typeof fixture>>;f=await fixture({boundary:(current)=>{if(current===boundary)f.owner.db.exec("INSERT OR IGNORE INTO restore_readiness VALUES('restored-host')");}});
    f.owner.db.exec("CREATE TABLE restore_readiness(id TEXT PRIMARY KEY)");f.restart({assertRestoreWriteReady:(db)=>{expect(db.inTransaction).toBe(true);if(db.prepare("SELECT 1 FROM restore_readiness LIMIT 1").get())throw new CheckpointError("RESTORE_WRITE_BLOCKED","Restored facts require verification");}});
    const operation=await f.accept();const result=await f.dispatch(operation.operationId);expect(result.resultCode).toBe("RESTORE_WRITE_BLOCKED");expect(f.owner.db.prepare("SELECT COUNT(*) n FROM restore_readiness").get()).toEqual({n:1});
    expect(f.resolve().epoch).toBe("epoch-1");expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("blocked");expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    expect(f.native.calls).toHaveLength(boundary==="projection.dispatch"?1:0);
    if(boundary==="validated")expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("current-workspace\n");
  },20_000);
});

const boundaries=["validated","safety_capture.dispatch","safety_capture.external","safety_captured","workspace_file.dispatch","workspace_file.external","workspace_file.applied","index.dispatch","index.external","index.applied","workspace_restored","provider.dispatch","provider.external","provider_rewound","projection.dispatch","projection_committed"];
describe("crash reconciliation at every stage",()=>{
  it.each(boundaries)("does not replay the unknown action after crash at %s",async(boundary)=>{
    let crash=true;const f=await fixture({boundary:(current)=>{if(current===boundary && crash){crash=false;throw new RevertCrash(current);}}});
    const operation=await f.accept("revert",`crash-${boundary}`);await expect(f.dispatch(operation.operationId)).rejects.toBeInstanceOf(RevertCrash);
    const stored=f.revert.store.require(operation.operationId,f.context.sessionId);const calls=f.native.calls.length;f.restart({onBoundary:()=>{}});
    if(boundary==="projection_committed"){expect(stored.status).toBe("completed");expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");return;}
    expect(f.newTurn).toThrow("RECOVERY_BLOCKED");
    if(stored.steps.some((step)=>step.state==="dispatching")){const current=f.owner.db.prepare("SELECT id FROM execution_intents WHERE resource_id=? ORDER BY created_at DESC LIMIT 1").get(operation.operationId) as {id:string};
      const {ExecutionStore}=await import("../storage/execution-store.js");await f.revert.handleIntent(new ExecutionStore(f.owner).get(current.id)!);expect(f.native.calls).toHaveLength(calls);}
    const resumed=await f.resume(operation.operationId);const result=await f.dispatch(resumed.operationId);expect(result.status).toBe("settled");
    expect(await readFile(join(f.root,"tracked.txt"),"utf8")).toBe("target-workspace\n");expect(f.owner.getSession(f.context.sessionId)?.recoveryState).toBe("idle");
  },20_000);
});

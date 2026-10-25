import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHostIdentity } from "../identity/host-identity.js";
import { SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { MANAGED_PROCESS_SCHEMA } from "../storage/migrations/004-managed-process-schema.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "../storage/migrations/005-process-evidence.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/recovery-fingerprint.js";
import { readCompatibilityEvidence } from "./compatibility-evidence.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { DispatchContext } from "../provider/types.js";
import { createCompatibilityCommittedRecorder, createCompatibilityRuntimeFacts, observedProviderVersion, recordManagedVersionObservation } from "./compatibility-runtime-facts.js";
import { measurePlannedNativeArtifact } from "./planned-native-artifact.js";
const databases: Database.Database[] = []; const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
const hash = (character: string) => character.repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(),"flyx-runtime-facts-")); roots.push(directory);
  const executable = join(directory,"fixture-provider"); await writeFile(executable,"structural version fixture only"); await chmod(executable,0o700);
  const db = new Database(":memory:"); databases.push(db);
  db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA + `CREATE TABLE host_state(key TEXT PRIMARY KEY,value_json TEXT,updated_at TEXT);
    CREATE TABLE native_turn_bindings(turn_id TEXT,attempt_id TEXT,provider TEXT,provider_instance_id TEXT,session_id TEXT,native_session_id TEXT,native_turn_id TEXT,workspace_path TEXT,configuration_fingerprint TEXT,verified_version TEXT,context_json TEXT);
    CREATE TABLE session_events(id TEXT,session_id TEXT,sequence INTEGER,type TEXT,payload_json TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE session_catalog(session_id TEXT PRIMARY KEY,provider_instance_id TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,canonical_root TEXT,worktree_root TEXT,checkout_key TEXT,kind TEXT,repository_id TEXT);
    CREATE TABLE provider_instances(id TEXT PRIMARY KEY,provider TEXT,executable TEXT,config_json TEXT,policy_version INTEGER,policy_capabilities_json TEXT);
    CREATE TABLE command_receipts(auth_subject_id TEXT,command_id TEXT,method TEXT,state TEXT,response_json TEXT,target_session_id TEXT);
    CREATE TABLE execution_intents(id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,attempt_id TEXT,kind TEXT,payload_json TEXT);
    CREATE TABLE interactions(interaction_id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,kind TEXT,attempt_id TEXT,runtime_id TEXT,runtime_generation INTEGER,native_request_id TEXT,native_method TEXT,status TEXT,created_at TEXT);
    CREATE TABLE interaction_delivery_evidence(id TEXT PRIMARY KEY,interaction_id TEXT,kind TEXT,source_id TEXT,created_at TEXT);`);
  const context: DispatchContext = {hostOwnerId:"fixture-owner",hostOwnerGeneration:1,runtimeId:"fixture:probe",runtimeGeneration:1,attemptId:"fixture-attempt",sessionId:"fixture-session",flyxTurnId:"probe-fixture"};
  const proof = {version:1 as const,boundaryId:"11111111-1111-4111-8111-111111111111",platform:"linux" as const,backend:"linux_bubblewrap" as const,kernelRelease:"fixture",backendVersion:"fixture",backendDigest:hash("a"),policyDigest:hash("b"),evidenceDigest:hash("c"),verifiedPrivateReadBoundary:true as const,verifiedPrivateWriteBoundary:true as const,verifiedChildInheritance:true as const,treeIsolation:"linux_pid_namespace" as const,verifiedDescendantStop:true};
  const provider: ProviderInstanceRecord = {providerInstanceId:"fixture-provider",provider:"codex",executable,config:{environment:{},sandboxRequired:true},policyVersion:1,state:"configured",verification:{state:"verified",runtimeVersion:"declared-untrusted-99.0.0",capabilities:[]},policyCapabilities:["streamingText"],createdAt:"fixture",updatedAt:"fixture"};
  const prepareVersionRuntime = vi.fn(async () => { throw new Error("NO_NATIVE_QUERY_IN_UNIT_TEST"); });
  const assertVersionProbeAuthorized = vi.fn();
  const options = {db,assertOwner(){},provider:()=>provider,workspace:directory,supervision:()=>proof,prepareVersionRuntime,assertVersionProbeAuthorized};
  const journal = new SqliteProcessJournal(db); const base = {...context,id:"fixture-process",treeControl:"process_group" as const,boundaryEvidence:{proof,launchDigest:hash("d")}};
  journal.save({...base,state:"launching"});
  journal.savePlannedLaunch({...base,state:"launching"},measurePlannedNativeArtifact({executable,args:["--version"],cwd:directory,env:{}}));
  const identity = {pid:12345,platform:"linux" as const,birth:{kind:"linux" as const,bootId:"22222222-2222-4222-8222-222222222222",startTicks:"100"}};
  const record = {...base,pid:identity.pid,processGroup:identity.pid,processIdentity:identity,state:"stopped" as const,stopProof:{kind:"verified-tree-stop" as const,sourceId:"structural-fixture",identityDigest:processIdentityDigest(identity),contractId:"native-boundary/v1/linux_bubblewrap/"+hash("c")}};
  journal.save(record);
  const observation = {context,processId:record.id,executable,rawVersion:"fixture-cli 1.2.3",stop:{stopped:true,treeStopped:true,records:[record]}};
  return {db,directory,executable,provider,proof,options,context,observation,prepareVersionRuntime};
}
describe("compatibility runtime facts with explicit structural source fixtures",()=>{
  it("does not turn configured version strings into observations or invoke native queries from measure",async()=>{
    const f=await fixture(); const facts=createCompatibilityRuntimeFacts(f.options);
    expect(()=>facts.measure()).toThrow("COMPATIBILITY_VERSION_OBSERVATION_UNAVAILABLE");
    expect(f.prepareVersionRuntime).not.toHaveBeenCalled();
    expect(()=>createCompatibilityRuntimeFacts({...f.options,supervision:()=>undefined}).measure()).toThrow("COMPATIBILITY_C0_UNAVAILABLE");
    await expect(createCompatibilityRuntimeFacts({...f.options,assertVersionProbeAuthorized(){throw new Error("UNAUTHORIZED_PROBE");}}).probeVersion()).rejects.toThrow("UNAUTHORIZED_PROBE");
    expect(f.prepareVersionRuntime).not.toHaveBeenCalled();
  });
  it("binds observed output to original managed version-query/stop and current executable bytes",async()=>{
    const f=await fixture(); recordManagedVersionObservation(f.db,f.provider,f.observation,()=>{});
    const facts=createCompatibilityRuntimeFacts(f.options), measured=facts.measure();
    expect(measured.providerVersion).toBe("1.2.3"); expect(measured.providerVersion).not.toBe(f.provider.verification.runtimeVersion);
    expect(measured.adapterVersion).toMatch(/^sha256-[a-f0-9]{64}$/); expect(measured.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(f.provider.executable,"changed bytes");
    expect(()=>facts.measure()).toThrow("COMPATIBILITY_VERSION_OBSERVATION_UNAVAILABLE");
    expect(()=>recordManagedVersionObservation(f.db,f.provider,f.observation,()=>{})).toThrow("COMPATIBILITY_VERSION_EXECUTABLE_CHANGED");
  });
  it("rejects unverified stop, ambiguous version output, and absent committed native binding before signing",async()=>{
    const f=await fixture();
    expect(()=>recordManagedVersionObservation(f.db,f.provider,{...f.observation,stop:{...f.observation.stop,treeStopped:false}},()=>{})).toThrow("COMPATIBILITY_C0_STOP_UNVERIFIED");
    expect(()=>observedProviderVersion("provider 1.2.3 and dependency 4.5.6")).toThrow("COMPATIBILITY_VERSION_OBSERVATION_INVALID");
    recordManagedVersionObservation(f.db,f.provider,f.observation,()=>{});
    const assertSceneObservation=vi.fn(); const recorder=createCompatibilityCommittedRecorder({db:f.db,identity:generateHostIdentity(),path:join(f.directory,"native.jsonl"),runId:"fixture-run",entryDigest:hash("f"),facts:createCompatibilityRuntimeFacts(f.options),assertSceneObservation});
    await expect(recorder.afterCommittedNativeStop(f.observation.context)).rejects.toThrow("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    expect(assertSceneObservation).toHaveBeenCalledWith(f.observation.context);
  });
});

/** The full committed-stop fact chain a verified recovery inspection re-proves: original binding, terminal event, live resource rows and the provider-launch journal. */
async function recoveryFixture(provider:"codex"|"claude"="codex") {
  const f=await fixture(); const {db}=f;
  f.provider.provider=provider;
  recordManagedVersionObservation(db,f.provider,f.observation,()=>{});
  const journal=new SqliteProcessJournal(db);
  const identity={pid:12346,platform:"linux" as const,birth:{kind:"linux" as const,bootId:"22222222-2222-4222-8222-222222222222",startTicks:"101"}};
  const turnBase={...f.context,id:"fixture-turn-process",treeControl:"process_group" as const,boundaryEvidence:{proof:f.proof,launchDigest:hash("e")}};
  journal.save({...turnBase,state:"launching"});
  journal.savePlannedLaunch({...turnBase,state:"launching"},measurePlannedNativeArtifact({executable:f.executable,args:["exec"],cwd:f.directory,env:{}}));
  journal.save({...turnBase,pid:identity.pid,processGroup:identity.pid,processIdentity:identity,state:"stopped" as const,
    stopProof:{kind:"verified-tree-stop" as const,sourceId:"structural-turn-fixture",identityDigest:processIdentityDigest(identity),contractId:"native-boundary/v1/linux_bubblewrap/"+hash("c")}});
  db.prepare("INSERT INTO sessions VALUES(?,?)").run(f.context.sessionId,"fixture-workspace");
  db.prepare("INSERT INTO session_catalog VALUES(?,?)").run(f.context.sessionId,f.provider.providerInstanceId);
  db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?)").run("fixture-workspace",f.directory,f.directory,"checkout-key","local","repository");
  db.prepare("INSERT INTO provider_instances VALUES(?,?,?,?,?,?)").run(f.provider.providerInstanceId,f.provider.provider,f.executable,JSON.stringify(f.provider.config),f.provider.policyVersion,JSON.stringify(f.provider.policyCapabilities));
  const recoveryFingerprint=catalogRecoveryConfigurationFingerprint({session:{workspaceId:"fixture-workspace"},
    providerInstance:{providerInstanceId:f.provider.providerInstanceId,provider:f.provider.provider,executable:f.executable,config:f.provider.config,policyVersion:f.provider.policyVersion,policyCapabilities:f.provider.policyCapabilities},
    workspace:{canonicalRoot:f.directory,worktreeRoot:f.directory,checkoutKey:"checkout-key",repositoryId:"repository",kind:"local"}});
  db.prepare("INSERT INTO native_turn_bindings(turn_id,attempt_id,provider,provider_instance_id,session_id,native_session_id,native_turn_id,workspace_path,configuration_fingerprint,verified_version,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(f.context.flyxTurnId,f.context.attemptId,provider,f.provider.providerInstanceId,f.context.sessionId,"native-session",
      provider==="claude"?null:"native-turn",f.directory,recoveryFingerprint,"unknown",JSON.stringify(f.context));
  db.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)").run("committed-turn-event",f.context.sessionId,1,"turn.completed",
    JSON.stringify({dispatchContext:f.context,terminalEvidence:{kind:"native-terminal",sourceId:"native-source"}}));
  for (const [key,value] of Object.entries({FLYX_COMPATIBILITY_MODE:"isolated",FLYX_COMPATIBILITY_REAL_ENABLED:"1",
    ...(provider==="claude"?{RUN_REAL_CLAUDE:"1"}:{RUN_REAL_CODEX:"1"})})) vi.stubEnv(key,value);
  const path=join(f.directory,"native.jsonl");
  const assertSceneObservation=vi.fn();
  const recorder=()=>createCompatibilityCommittedRecorder({db,identity:generateHostIdentity(),path,runId:"fixture-run",entryDigest:hash("f"),
    facts:createCompatibilityRuntimeFacts(f.options),assertSceneObservation});
  const observation={state:"terminal" as const,nativeSessionId:"native-session",nativeTurnId:"native-turn",status:"completed" as const,
    evidence:{kind:"native-terminal" as const,sourceId:"sha256:thread-read-digest",verifiedVersion:"1.2.3"}};
  return {...f,path,recorder,assertSceneObservation,observation};
}
describe("recovery-inspection evidence recorder",()=>{
  it("records a verified read-only recovery inspection bound to the original committed stop",async()=>{
    const f=await recoveryFixture();
    const recorder=f.recorder();
    await recorder.afterVerifiedRecoveryInspection(f.context,f.observation);
    await recorder.drain();
    expect(f.assertSceneObservation).toHaveBeenCalledWith(f.context);
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({provider:"codex",kind:"recovery",result:"passed",nativeEvent:"inspect",evidenceCode:"NATIVE_HISTORY_INSPECT_VERIFIED",
      runId:"fixture-run",domain:"isolated-real",trusted:true,capability:"recovery",launchRef:"fixture-turn-process"});
  });
  it("refuses observations that disagree with the original binding or the verified version",async()=>{
    const f=await recoveryFixture();
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,{...f.observation,evidence:{...f.observation.evidence,sourceId:""}})).rejects.toThrow("COMPATIBILITY_RECOVERY_OBSERVATION_INVALID");
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,{...f.observation,evidence:{...f.observation.evidence,verifiedVersion:"9.9.9"}})).rejects.toThrow("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,{...f.observation,nativeSessionId:"other-session"})).rejects.toThrow("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,{...f.observation,nativeTurnId:"other-turn"})).rejects.toThrow("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
    // The original terminal event proved completed; a read that claims failed disagrees.
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,{...f.observation,status:"failed"})).rejects.toThrow("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
    expect(readCompatibilityEvidence(f.path).entries).toHaveLength(0);
  });
  it("fails closed when the original native terminal event is absent or ambiguous",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("DELETE FROM session_events").run();
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,f.observation)).rejects.toThrow("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
    f.db.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)").run("event-a",f.context.sessionId,1,"turn.completed",
      JSON.stringify({dispatchContext:f.context,terminalEvidence:{kind:"native-terminal",sourceId:"native-source"}}));
    f.db.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)").run("event-b",f.context.sessionId,2,"turn.cancelled",
      JSON.stringify({dispatchContext:f.context,terminalEvidence:{kind:"native-terminal",sourceId:"native-source-2"}}));
    await expect(f.recorder().afterVerifiedRecoveryInspection(f.context,f.observation)).rejects.toThrow("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
  });
});

describe("committed-stop interactive evidence recorder",()=>{
  it("records an interrupt capability when a commanded cancellation terminates the turn",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("UPDATE session_events SET type='turn.cancelled'").run();
    f.db.prepare("INSERT INTO command_receipts VALUES(?,?,?,?,?,?)")
      .run("device","interrupt-cmd","session.interrupt","accepted",JSON.stringify({status:"accepted",turnId:f.context.flyxTurnId}),f.context.sessionId);
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({provider:"codex",kind:"interrupt",capability:"interrupt",result:"passed",
      evidenceCode:"NATIVE_INTERRUPT_CANCELLED",nativeEvent:"turn/cancelled",launchRef:"fixture-turn-process",stopRef:"fixture-turn-process"});
    // A receipt that never settled to a command outcome proves nothing: the
    // same cancelled terminal now records as a plain failed turn.
    f.db.prepare("UPDATE command_receipts SET state='outcome_unknown'").run();
    const second=f.recorder();
    await second.afterCommittedNativeStop(f.context);
    await second.drain();
    const finalEntries=readCompatibilityEvidence(f.path).entries;
    expect(finalEntries.filter((entry)=>entry.kind==="interrupt")).toHaveLength(1);
    expect(finalEntries.filter((entry)=>entry.kind==="turn"&&entry.result==="failed")).toHaveLength(1);
  });
  it("records a failed turn when a cancellation was not commanded",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("UPDATE session_events SET type='turn.cancelled'").run();
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({kind:"turn",capability:"turn",result:"failed",evidenceCode:"NATIVE_TERMINAL_FAILED"});
  });
  it("records one approval capability per confirmed native-ack interaction",async()=>{
    const f=await recoveryFixture();
    f.db.prepare(`INSERT INTO interactions(interaction_id,session_id,turn_id,kind,attempt_id,runtime_id,runtime_generation,native_request_id,native_method,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run("interaction-1",f.context.sessionId,f.context.flyxTurnId,"approval",f.context.attemptId,f.context.runtimeId,f.context.runtimeGeneration,
        "toolu-1","item/commandExecution/requestApproval","confirmed","2026-01-01T00:00:00.000Z");
    f.db.prepare("INSERT INTO interaction_delivery_evidence VALUES(?,?,?,?,?)")
      .run("delivery-1","interaction-1","native-ack","native-ack-source","2026-01-01T00:00:00.000Z");
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({kind:"turn",capability:"turn",result:"passed",evidenceCode:"NATIVE_TERMINAL_COMPLETED"});
    expect(entries[1]).toMatchObject({provider:"codex",kind:"approval",capability:"approval",result:"passed",
      evidenceCode:"NATIVE_APPROVAL_CONFIRMED",nativeEvent:"item/commandExecution/requestApproval",launchRef:"fixture-turn-process"});
    expect(entries[1]?.nativeRequestIdHash).toMatch(/^[a-f0-9]{64}$/);
    // Pending interactions are not evidence: only confirmed rows record.
    f.db.prepare("UPDATE interactions SET status='pending'").run();
    const second=f.recorder();
    await second.afterCommittedNativeStop(f.context);
    await second.drain();
    const finalEntries=readCompatibilityEvidence(f.path).entries;
    expect(finalEntries.filter((entry)=>entry.kind==="approval")).toHaveLength(1);
  });
  it("records a claude approval pinned by the interaction anchor without claiming the turn's terminal result id",async()=>{
    const f=await recoveryFixture("claude");
    f.db.prepare(`INSERT INTO interactions(interaction_id,session_id,turn_id,kind,attempt_id,runtime_id,runtime_generation,native_request_id,native_method,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run("interaction-claude",f.context.sessionId,f.context.flyxTurnId,"approval",f.context.attemptId,f.context.runtimeId,f.context.runtimeGeneration,
        "toolu-claude","canUseTool/approval","confirmed","2026-01-01T00:00:00.000Z");
    f.db.prepare("INSERT INTO interaction_delivery_evidence VALUES(?,?,?,?,?)")
      .run("delivery-claude","interaction-claude","native-ack","native-ack-source","2026-01-01T00:00:00.000Z");
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({provider:"claude",kind:"turn",capability:"turn",result:"passed",evidenceCode:"NATIVE_TERMINAL_COMPLETED"});
    expect(entries[1]).toMatchObject({provider:"claude",kind:"approval",capability:"approval",result:"passed",
      evidenceCode:"NATIVE_APPROVAL_CONFIRMED",nativeEvent:"canUseTool/approval",launchRef:"fixture-turn-process",stopRef:"fixture-turn-process"});
    expect(entries[1]?.nativeRequestIdHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("records a reconnect capability when the start intent resumed the pre-restart native session",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("INSERT INTO execution_intents VALUES(?,?,?,?,?,?)")
      .run("intent-1",f.context.sessionId,f.context.flyxTurnId,f.context.attemptId,"start_turn",
        JSON.stringify({turnId:f.context.flyxTurnId,prompt:"fixture",resumeSessionId:"native-session"}));
    f.db.prepare("INSERT INTO native_turn_bindings(turn_id,attempt_id,provider,provider_instance_id,session_id,native_session_id,native_turn_id,workspace_path,configuration_fingerprint,verified_version,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("probe-fixture-earlier","fixture-attempt-earlier","codex",f.provider.providerInstanceId,f.context.sessionId,"native-session","native-turn-earlier",
        f.directory,"irrelevant-fingerprint","unknown",
        JSON.stringify({...f.context,flyxTurnId:"probe-fixture-earlier",attemptId:"fixture-attempt-earlier",hostOwnerGeneration:0}));
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({kind:"turn",result:"passed"});
    expect(entries[1]).toMatchObject({provider:"codex",kind:"reconnect",capability:"reconnect",result:"passed",
      evidenceCode:"NATIVE_RECONNECT_RESUMED",launchRef:"fixture-turn-process"});
  });
  it("does not record reconnect without a resume pin or a host-owner generation delta",async()=>{
    const f=await recoveryFixture();
    f.db.prepare("INSERT INTO execution_intents VALUES(?,?,?,?,?,?)")
      .run("intent-1",f.context.sessionId,f.context.flyxTurnId,f.context.attemptId,"start_turn",
        JSON.stringify({turnId:f.context.flyxTurnId,prompt:"fixture",resumeSessionId:"native-session"}));
    f.db.prepare("INSERT INTO native_turn_bindings(turn_id,attempt_id,provider,provider_instance_id,session_id,native_session_id,native_turn_id,workspace_path,configuration_fingerprint,verified_version,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run("probe-fixture-earlier","fixture-attempt-earlier","codex",f.provider.providerInstanceId,f.context.sessionId,"native-session","native-turn-earlier",
        f.directory,"irrelevant-fingerprint","unknown",
        JSON.stringify({...f.context,flyxTurnId:"probe-fixture-earlier",attemptId:"fixture-attempt-earlier"}));
    const recorder=f.recorder();
    await recorder.afterCommittedNativeStop(f.context);
    await recorder.drain();
    const entries=readCompatibilityEvidence(f.path).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({kind:"turn",result:"passed"});
    expect(entries.some((entry)=>entry.kind==="reconnect")).toBe(false);
  });
});

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
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { DispatchContext } from "../provider/types.js";
import { createCompatibilityCommittedRecorder, createCompatibilityRuntimeFacts, observedProviderVersion, recordManagedVersionObservation } from "./compatibility-runtime-facts.js";
import { measurePlannedNativeArtifact } from "./planned-native-artifact.js";
const databases: Database.Database[] = []; const roots: string[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
const hash = (character: string) => character.repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(),"flyx-runtime-facts-")); roots.push(directory);
  const executable = join(directory,"fixture-provider"); await writeFile(executable,"structural version fixture only"); await chmod(executable,0o700);
  const db = new Database(":memory:"); databases.push(db);
  db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA + `CREATE TABLE host_state(key TEXT PRIMARY KEY,value_json TEXT,updated_at TEXT);
    CREATE TABLE native_turn_bindings(turn_id TEXT,attempt_id TEXT);`);
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
  return {db,directory,provider,proof,options,observation,prepareVersionRuntime};
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

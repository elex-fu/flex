import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteProcessJournal } from "../lifecycle/managed-process-registry.js";
import { processIdentityDigest } from "../lifecycle/managed-process-evidence.js";
import { MANAGED_PROCESS_SCHEMA } from "../storage/migrations/004-managed-process-schema.js";
import { MANAGED_PROCESS_EVIDENCE_SCHEMA } from "../storage/migrations/005-process-evidence.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import { catalogRecoveryConfigurationFingerprint } from "../session/recovery-fingerprint.js";
import { resolveManagedNativeProvenance, saveCompatibilityLaunchArtifact } from "./managed-native-provenance.js";
import type { DispatchContext } from "../provider/types.js";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const hash = (character: string) => character.repeat(64);
const providerConfig = { environment: { FLYX_TEST: "1" }, sandboxRequired: true as const };
const policyVersion = 1;
const policyCapabilities = ["workspaceWrite", "interrupt"];
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(MANAGED_PROCESS_SCHEMA + MANAGED_PROCESS_EVIDENCE_SCHEMA + `CREATE TABLE host_state(key TEXT PRIMARY KEY,value_json TEXT,updated_at TEXT);
    CREATE TABLE native_turn_bindings(turn_id TEXT,attempt_id TEXT,provider TEXT,provider_instance_id TEXT,session_id TEXT,native_session_id TEXT,native_turn_id TEXT,workspace_path TEXT,configuration_fingerprint TEXT,verified_version TEXT,context_json TEXT);
    CREATE TABLE session_events(id TEXT,session_id TEXT,sequence INTEGER,type TEXT,payload_json TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE session_catalog(session_id TEXT PRIMARY KEY,provider_instance_id TEXT);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,canonical_root TEXT,worktree_root TEXT,checkout_key TEXT,kind TEXT,repository_id TEXT);
    CREATE TABLE provider_instances(id TEXT PRIMARY KEY,provider TEXT,executable TEXT,config_json TEXT,policy_version INTEGER,policy_capabilities_json TEXT);`);
  const context: DispatchContext = { hostOwnerId: "owner", hostOwnerGeneration: 1, runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt", sessionId: "session", flyxTurnId: "turn" };
  const proof = { version: 1 as const, boundaryId: "11111111-1111-4111-8111-111111111111", platform: "linux" as const, backend: "linux_bubblewrap" as const, kernelRelease: "fixture", backendVersion: "fixture", backendDigest: hash("a"), policyDigest: hash("b"), evidenceDigest: hash("c"), verifiedPrivateReadBoundary: true as const, verifiedPrivateWriteBoundary: true as const, verifiedChildInheritance: true as const, treeIsolation: "linux_pid_namespace" as const, verifiedDescendantStop: true };
  const artifact = { providerVersion: "1", executablePath: "/fixture/provider", executableDigest: hash("a"), configFingerprint: providerConfigurationFingerprint({ config: providerConfig, policyVersion }), adapterId: "fixture", adapterVersion: "1", runtimeVersion: "1", runtimeDigest: hash("d"), nodeVersion: "24.0.0", os: "linux fixture", supervisionContractId: "native-boundary/v1/linux_bubblewrap/" + hash("c") };
  const journal = new SqliteProcessJournal(db);
  const base = { ...context, id: "process", treeControl: "process_group" as const, boundaryEvidence: { proof, launchDigest: hash("e") } };
  journal.save({ ...base, state: "launching" });
  const snapshot = () => saveCompatibilityLaunchArtifact(db, { processId: base.id, launchDigest: hash("e"), artifact, assertOwner() {} });
  snapshot();
  const identity = { pid: 12345, platform: "linux" as const, birth: { kind: "linux" as const, bootId: "22222222-2222-4222-8222-222222222222", startTicks: "100" } };
  const stopProof = { kind: "verified-tree-stop" as const, sourceId: "fixture-kernel-observation", identityDigest: processIdentityDigest(identity), contractId: artifact.supervisionContractId };
  journal.save({ ...base, pid: identity.pid, processGroup: identity.pid, processIdentity: identity, state: "stopped", stopProof });
  // The live catalog rows the binding and the artifact must both re-derive from:
  // the binding's configuration_fingerprint is the recovery-domain digest over
  // these rows, while the artifact's configFingerprint is the provider
  // activation digest over the same provider configuration.
  db.prepare("INSERT INTO sessions VALUES(?,?)").run(context.sessionId, "workspace");
  db.prepare("INSERT INTO session_catalog VALUES(?,?)").run(context.sessionId, "provider-instance");
  db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?)").run("workspace", "/fixture/canonical", "/fixture/worktree", "checkout-key", "local", "repository");
  db.prepare("INSERT INTO provider_instances VALUES(?,?,?,?,?,?)").run("provider-instance", "codex", "/fixture/provider", JSON.stringify(providerConfig), policyVersion, JSON.stringify(policyCapabilities));
  const recoveryFingerprint = catalogRecoveryConfigurationFingerprint({ session: { workspaceId: "workspace" },
    providerInstance: { providerInstanceId: "provider-instance", provider: "codex", executable: "/fixture/provider", config: providerConfig, policyVersion, policyCapabilities },
    workspace: { canonicalRoot: "/fixture/canonical", worktreeRoot: "/fixture/worktree", checkoutKey: "checkout-key", repositoryId: "repository", kind: "local" } });
  db.prepare("INSERT INTO native_turn_bindings(turn_id,attempt_id,provider,provider_instance_id,session_id,native_session_id,native_turn_id,workspace_path,configuration_fingerprint,verified_version,context_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("turn", "attempt", "codex", "provider-instance", "session", "native-session", "native-turn", "/fixture/canonical", recoveryFingerprint, "unknown", JSON.stringify(context));
  db.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)").run("committed-event", "session", 1, "turn.completed", JSON.stringify({ dispatchContext: context, terminalEvidence: { kind: "native-terminal", sourceId: "native-source" } }));
  const evidence = { provider: "codex" as const, kind: "turn" as const, result: "passed" as const, nativeEvent: "turn/completed", nativeSourceId: "native-source", nativeSessionId: "native-session", nativeTurnId: "native-turn", attemptId: "attempt", evidenceCode: "NATIVE_TERMINAL_COMPLETED", launchRef: "process" };
  return { db, context, artifact, evidence, snapshot };
}
describe("original journal provenance using explicit structural fixtures", () => {
  it("joins immutable launch snapshot, exact native binding, original captured native event, and actual stop proof", () => {
    const f = fixture(); const observed = resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact);
    expect(observed).toMatchObject({ provider: "codex", executableDigest: f.artifact.executableDigest, runtimeDigest: f.artifact.runtimeDigest });
    expect(observed.launchRecordDigest).toMatch(/^[a-f0-9]{64}$/); expect(observed.nativeObservationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.stopRecordDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses late or changed launch snapshots, cross-attempt binding, public-only terminal, and missing stop proof", () => {
    const f = fixture(); expect(f.snapshot).toThrow("COMPATIBILITY_LAUNCH_SNAPSHOT_LATE");
    expect(() => resolveManagedNativeProvenance(f.db, { ...f.context, runtimeGeneration: 2 }, f.evidence, f.artifact)).toThrow("COMPATIBILITY_LAUNCH_CONTEXT_MISMATCH");
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, { ...f.artifact, executableDigest: hash("f") })).toThrow("COMPATIBILITY_LAUNCH_ARTIFACT_MISMATCH");
    f.db.prepare("UPDATE session_events SET payload_json=?").run(JSON.stringify({ dispatchContext: f.context, kind: "turn_completed" }));
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
    f.db.prepare("UPDATE session_events SET payload_json=?").run(JSON.stringify({ dispatchContext: f.context, terminalEvidence: { kind: "native-terminal", sourceId: "native-source" } }));
    f.db.exec("DELETE FROM managed_process_stop_proofs");
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_STOP_PROOF_MISSING");
  });
  it("refuses bindings that do not match the live resource rows, artifacts that attest another configuration, and conflicting known versions", () => {
    const f = fixture();
    // A known-but-conflicting verified_version is refused; "unknown" is accepted
    // because the version is proven by the probe fact and executable digest.
    f.db.prepare("UPDATE native_turn_bindings SET verified_version=?").run("9.9.9");
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    f.db.prepare("UPDATE native_turn_bindings SET verified_version=?").run("unknown");
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).not.toThrow();
    // The binding's fingerprint is recovery-domain: it must re-derive from the
    // live session/workspace/provider rows, not from the artifact.
    f.db.prepare("UPDATE native_turn_bindings SET configuration_fingerprint=?").run(hash("z"));
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    f.db.prepare("UPDATE provider_instances SET config_json=?").run(JSON.stringify({ ...providerConfig, environment: { FLYX_TEST: "2" } }));
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
  });
  it("does not infer executable/runtime facts when the original launch snapshot is absent", () => {
    const f = fixture(); f.db.exec("DELETE FROM host_state");
    expect(() => resolveManagedNativeProvenance(f.db, f.context, f.evidence, f.artifact)).toThrow("COMPATIBILITY_LAUNCH_ARTIFACT_UNAVAILABLE");
  });
});

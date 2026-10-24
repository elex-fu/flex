import { nativeStopContractId, supportsNativeStop } from "../lifecycle/managed-stop-contract.js";
import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HostIdentityFileV1 } from "../identity/host-identity.js";
import { isNativeBoundaryProof, type NativeBoundaryProof } from "../lifecycle/native-boundary-proof.js";
import { validateTreeStopEvidence, type ProcessTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import { OperationsError } from "../operations/operation-files.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import type { ProviderRuntimeFacts } from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { DispatchContext } from "../provider/types.js";
import { inspectNativeVersion, type ManagedVersionObservation, type PreparedNativeRuntime } from "../provider/managed-runtime.js";
import type { NativeTurnObservation } from "../provider/native-history.js";
import { CompatibilityEvidenceRecorder, compatibilityEvidenceHash, type NativeCompatibilityArtifact, type NativeCompatibilityEvidence } from "./compatibility-evidence.js";
import { compatibilityCanonicalJson, compatibilityDigest } from "./compatibility-integrity.js";
import { COMPATIBILITY_SCENE_VERSION } from "./compatibility-readiness.js";
import { sceneSegments } from "./compatibility-scenes.js";
import { resolveManagedNativeProvenance } from "./managed-native-provenance.js";
import { measureRuntimeFile, measuredHostBuildDigest, type PlannedNativeArtifact } from "./planned-native-artifact.js";

const fail = (code: string): never => { throw new OperationsError(code); };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionKey = (provider: string, executable: { path: string; digest: string }, configuration: string, contractId: string) => "compatibility-version/v1/" + compatibilityDigest({ provider, executable, configuration, contractId });
export function observedProviderVersion(output: string): string {
  const matches = [...output.matchAll(/\b(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\b/g)].map((match) => match[1]!);
  if (output.length > 16 * 1024 || new Set(matches).size !== 1) return fail("COMPATIBILITY_VERSION_OBSERVATION_INVALID");
  return matches[0]!;
}
type QueryFact = { v: 1; provider: "claude" | "codex"; processId: string; context: DispatchContext; version: string;
  outputDigest: string; executablePath: string; executableDigest: string; plannedDigest: string; configFingerprint: string; observedAt: string };
function originalVersionSource(db: Database.Database, context: DispatchContext, processId: string) {
  const row = db.prepare(`SELECT p.*,i.identity_json,b.proof_json AS boundary_json,b.launch_digest,s.proof_json AS stop_json
    FROM managed_processes p JOIN managed_process_identities i ON i.process_id=p.id JOIN managed_process_boundaries b ON b.process_id=p.id
    JOIN managed_process_stop_proofs s ON s.process_id=p.id WHERE p.id=?`).get(processId) as Record<string, unknown> | undefined;
  if (!row) return fail("COMPATIBILITY_VERSION_SOURCE_UNAVAILABLE");
  if (row.owner_id !== context.hostOwnerId || row.owner_generation !== context.hostOwnerGeneration || row.runtime_id !== context.runtimeId
    || row.runtime_generation !== context.runtimeGeneration || row.attempt_id !== context.attemptId || row.session_id !== context.sessionId
    || row.turn_id !== context.flyxTurnId || row.state !== "stopped") fail("COMPATIBILITY_VERSION_SOURCE_MISMATCH");
  const plannedRow = db.prepare("SELECT value_json FROM host_state WHERE key=?").get("compatibility-planned-launch/v1/" + processId) as { value_json: string } | undefined;
  if (!plannedRow) return fail("COMPATIBILITY_VERSION_SOURCE_UNAVAILABLE");
  const snapshot = JSON.parse(plannedRow.value_json) as { v: number; processId: string; launchDigest: string; planned: PlannedNativeArtifact };
  const { snapshotDigest, ...planned } = snapshot.planned;
  const boundary: unknown = JSON.parse(String(row.boundary_json));
  const stop = JSON.parse(String(row.stop_json)) as ProcessTreeStopEvidence;
  const identity = JSON.parse(String(row.identity_json)) as ProcessIdentity;
  if (snapshot.v !== 1 || snapshot.processId !== processId || snapshot.launchDigest !== row.launch_digest || snapshot.planned.operation !== "version-query"
    || compatibilityDigest(planned) !== snapshotDigest || !isNativeBoundaryProof(boundary) || !supportsNativeStop(boundary)
    || stop.contractId !== nativeStopContractId(boundary)) fail("COMPATIBILITY_VERSION_SOURCE_MISMATCH");
  validateTreeStopEvidence(stop, identity, { proof: boundary as NativeBoundaryProof, launchDigest: String(row.launch_digest) }, Number(row.process_group));
  return { planned: snapshot.planned, boundary: boundary as NativeBoundaryProof, stop };
}
export function recordManagedVersionObservation(db: Database.Database, provider: ProviderInstanceRecord,
  observation: ManagedVersionObservation, assertOwner: () => void): void {
  assertOwner();
  if (!observation.stop.stopped || !observation.stop.treeStopped && !observation.stop.records.some((record) => record.stopProof?.kind === "managed-group-stop")
    || !observation.stop.records.some((record) => record.id === observation.processId && record.state === "stopped" && record.stopProof)) fail("COMPATIBILITY_C0_STOP_UNVERIFIED");
  const source = originalVersionSource(db, observation.context, observation.processId);
  const executable = measureRuntimeFile(provider.executable);
  if (realpathSync(observation.executable) !== executable.path || source.planned.executable.path !== executable.path || source.planned.executable.digest !== executable.digest) fail("COMPATIBILITY_VERSION_EXECUTABLE_CHANGED");
  const configFingerprint = providerConfigurationFingerprint(provider);
  const fact: QueryFact = { v: 1, provider: provider.provider, processId: observation.processId, context: observation.context,
    version: observedProviderVersion(observation.rawVersion), outputDigest: compatibilityEvidenceHash(observation.rawVersion), executablePath: executable.path,
    executableDigest: executable.digest, plannedDigest: source.planned.snapshotDigest, configFingerprint, observedAt: new Date().toISOString() };
  const key = versionKey(provider.provider, executable, configFingerprint, source.stop.contractId), value = compatibilityCanonicalJson(fact);
  db.transaction(() => { const previous = db.prepare("SELECT value_json FROM host_state WHERE key=?").get(key) as { value_json: string } | undefined;
    if (previous) { const saved = JSON.parse(previous.value_json) as QueryFact; if (saved.version !== fact.version) fail("COMPATIBILITY_VERSION_OBSERVATION_CONFLICT"); return; }
    db.prepare("INSERT INTO host_state(key,value_json,updated_at) VALUES(?,?,?)").run(key, value, fact.observedAt);
  })();
}
export interface CompatibilityRuntimeFactsOptions {
  db: Database.Database;
  assertOwner(): void;
  provider(): ProviderInstanceRecord;
  workspace: string;
  /** Actual current C0 assessment; a configured contract string is insufficient. */
  supervision(): NativeBoundaryProof | undefined;
  assertVersionProbeAuthorized(input: { provider: "claude" | "codex"; executable: { path: string; digest: string }; configFingerprint: string; runtimeDigest: string; operation: "--version" }): void;
  /** Explicit source bootstrap only. Ordinary measure/activation never invokes it. */
  prepareVersionRuntime(): Promise<PreparedNativeRuntime>;
}
function packageMetadata(path: string): { version: string } {
  const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(value.version)) return fail("COMPATIBILITY_INSTALLED_METADATA_UNAVAILABLE");
  return { version: value.version };
}
function installedSdk(): { version: string; entry: string } {
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  let directory = dirname(entry);
  for (let depth = 0; depth < 6; depth++) { try { const path = join(directory, "package.json"); const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    if (value.name === "@anthropic-ai/claude-agent-sdk") return { ...packageMetadata(path), entry };
  } catch { /* inspect the owning installed package only */ } directory = dirname(directory); }
  return fail("COMPATIBILITY_INSTALLED_METADATA_UNAVAILABLE");
}
/** Installed adapter/SDK bytes; providerVersion must come from a measured, trusted artifact. */
export function installedProviderRuntimeFacts(provider: "claude" | "codex", providerVersion: string): ProviderRuntimeFacts {
  const adapter = measureRuntimeFile(join(root, provider, "adapter" + (root.endsWith("/dist") ? ".js" : ".ts")));
  return { providerVersion, ...(provider === "claude" ? { sdkVersion: installedSdk().version } : {}),
    adapterId: provider === "claude" ? "claude-agent-sdk" : "codex-app-server", adapterVersion: "sha256-" + adapter.digest };
}
export function createCompatibilityRuntimeFacts(options: CompatibilityRuntimeFactsOptions) {
  const measure = (): NativeCompatibilityArtifact => {
    options.assertOwner(); const provider = options.provider();
    const proof = options.supervision();
    if (!proof || !isNativeBoundaryProof(proof) || !supportsNativeStop(proof)) return fail("COMPATIBILITY_C0_UNAVAILABLE");
    const executable = measureRuntimeFile(provider.executable), configFingerprint = providerConfigurationFingerprint(provider);
    const stored = options.db.prepare("SELECT value_json FROM host_state WHERE key=?").get(versionKey(provider.provider, executable, configFingerprint, nativeStopContractId(proof))) as { value_json: string } | undefined;
    if (!stored) return fail("COMPATIBILITY_VERSION_OBSERVATION_UNAVAILABLE");
    const fact = JSON.parse(stored.value_json) as QueryFact;
    const source = originalVersionSource(options.db, fact.context, fact.processId);
    if (fact.v !== 1 || fact.provider !== provider.provider || fact.executablePath !== executable.path || fact.executableDigest !== executable.digest
      || fact.configFingerprint !== configFingerprint || fact.plannedDigest !== source.planned.snapshotDigest || source.planned.executable.digest !== executable.digest
      || nativeStopContractId(source.boundary) !== nativeStopContractId(proof) || source.planned.nodeExecutable.digest !== measureRuntimeFile(process.execPath).digest
      || !/^[a-f0-9]{64}$/.test(fact.outputDigest)) return fail("COMPATIBILITY_VERSION_SOURCE_MISMATCH");
    const adapter = measureRuntimeFile(join(root, provider.provider, "adapter" + (root.endsWith("/dist") ? ".js" : ".ts")));
    const host = packageMetadata(resolve(root, "../package.json"));
    const sdk = provider.provider === "claude" ? installedSdk() : undefined;
    return Object.freeze({ providerVersion: fact.version, executablePath: executable.path, executableDigest: executable.digest, configFingerprint,
      ...(sdk ? { sdkVersion: sdk.version } : {}), adapterId: provider.provider === "claude" ? "claude-agent-sdk" : "codex-app-server", adapterVersion: "sha256-" + adapter.digest,
      runtimeVersion: host.version, runtimeDigest: measuredHostBuildDigest(), nodeVersion: process.versions.node, os: source.planned.os,
      supervisionContractId: nativeStopContractId(proof) });
  };
  return Object.freeze({ measure,
    /** Runs only the managed exact --version query, never preflight/model execution. */
    probeVersion: async () => {
      options.assertOwner(); const provider = options.provider(); const fingerprint = providerConfigurationFingerprint(provider);
      const executable = measureRuntimeFile(provider.executable);
      const authorityInput = { provider: provider.provider, executable, configFingerprint: fingerprint, runtimeDigest: measuredHostBuildDigest(), operation: "--version" as const };
      options.assertVersionProbeAuthorized(authorityInput);
      const runtime = await options.prepareVersionRuntime();
      const currentExecutable = measureRuntimeFile(options.provider().executable);
      if (currentExecutable.path !== executable.path || currentExecutable.digest !== executable.digest || providerConfigurationFingerprint(options.provider()) !== fingerprint) return fail("COMPATIBILITY_VERSION_CONFIG_CHANGED");
      options.assertVersionProbeAuthorized({ ...authorityInput, runtimeDigest: measuredHostBuildDigest() });
      await inspectNativeVersion(runtime, provider.executable, options.workspace, { PATH: process.env.PATH ?? "/usr/bin:/bin", ...provider.config.environment }, 5_000,
        (observation) => { options.assertOwner(); if (providerConfigurationFingerprint(options.provider()) !== fingerprint || options.provider().executable !== provider.executable) fail("COMPATIBILITY_VERSION_CONFIG_CHANGED"); recordManagedVersionObservation(options.db, provider, observation, options.assertOwner); });
      return measure();
    },
  });
}
export function createCompatibilityCommittedRecorder(options: {
  db: Database.Database; identity: HostIdentityFileV1; path: string; runId: string; entryDigest: string;
  facts: ReturnType<typeof createCompatibilityRuntimeFacts>;
  assertSceneObservation(context: DispatchContext): void;
  /** Registered scene the run executes; defaults to the c3 basic scene. */
  sceneVersion?: string | undefined;
}) {
  const sceneVersion = options.sceneVersion ?? COMPATIBILITY_SCENE_VERSION;
  if (sceneSegments(sceneVersion) === undefined) fail("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED");
  const contexts = new Map<string, DispatchContext>();
  const recorder = new CompatibilityEvidenceRecorder(options.path, true, options.runId, { domain: "isolated-real", identity: options.identity,
    artifact: () => options.facts.measure(), sceneVersion, entryDigest: options.entryDigest,
    assertNativeProvenance: (evidence, artifact) => { const context = contexts.get(evidence.attemptId); if (!context) return fail("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING"); return resolveManagedNativeProvenance(options.db, context, evidence, artifact); } });
  return Object.freeze({ drain: () => recorder.drain(),
    afterCommittedNativeStop: async (context: DispatchContext) => {
      const facts = await collectStopFacts(context);
      const evidence: NativeCompatibilityEvidence = { provider: facts.provider, kind: "turn", capability: "turn", result: facts.source.type === "turn.completed" ? "passed" : "failed",
        nativeEvent: facts.provider === "claude" ? "result" : "turn/completed", nativeSourceId: facts.nativeSourceId,
        ...(facts.provider === "claude" ? { nativeResultId: facts.nativeSourceId } : { nativeTurnId: String(facts.binding.native_turn_id) }),
        nativeSessionId: String(facts.binding.native_session_id), attemptId: context.attemptId, launchRef: facts.matches[0]!.id, stopRef: facts.matches[0]!.id,
        evidenceCode: facts.source.type === "turn.completed" ? "NATIVE_TERMINAL_COMPLETED" : "NATIVE_TERMINAL_FAILED" };
      contexts.set(context.attemptId, context);
      try { await recorder.record(evidence); } finally { contexts.delete(context.attemptId); }
    },
    /**
     * Records one verified read-only native-history inspection (design §8.2
     * R4): only after the reader returned a terminal observation whose native
     * session, verified version and terminal status match the original turn
     * binding still proven by the shared fact chain. Recording is observation
     * only; the inspection itself never dispatched or spawned anything.
     */
    afterVerifiedRecoveryInspection: async (context: DispatchContext, observation: NativeTurnObservation & { state: "terminal" }) => {
      if (observation.state !== "terminal" || !observation.evidence?.sourceId || !observation.evidence?.verifiedVersion) return fail("COMPATIBILITY_RECOVERY_OBSERVATION_INVALID");
      const facts = await collectStopFacts(context);
      const nativeSessionId = String(facts.binding.native_session_id);
      if (observation.nativeSessionId !== nativeSessionId || observation.evidence.verifiedVersion !== facts.artifact.providerVersion) return fail("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
      const status = observation.status === "completed" && facts.source.type === "turn.completed" || observation.status === "failed" && facts.source.type === "turn.failed"
        || observation.status === "cancelled" && facts.source.type === "turn.cancelled" ? observation.status : undefined;
      if (!status) return fail("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
      if (observation.nativeTurnId !== undefined && String(facts.binding.native_turn_id ?? "") !== observation.nativeTurnId) return fail("COMPATIBILITY_RECOVERY_OBSERVATION_MISMATCH");
      const evidence: NativeCompatibilityEvidence = { provider: facts.provider, kind: "recovery", capability: "recovery", result: "passed",
        nativeEvent: "inspect", evidenceCode: "NATIVE_HISTORY_INSPECT_VERIFIED", nativeSourceId: observation.evidence.sourceId,
        ...(facts.binding.native_turn_id !== null && facts.binding.native_turn_id !== undefined ? { nativeTurnId: String(facts.binding.native_turn_id) } : {}),
        nativeSessionId, attemptId: context.attemptId, launchRef: facts.matches[0]!.id };
      contexts.set(context.attemptId, context);
      try { await recorder.record(evidence); } finally { contexts.delete(context.attemptId); }
    },
  });

  /** The shared fact chain behind both committed-stop and recovery-inspection evidence. */
  async function collectStopFacts(context: DispatchContext): Promise<{
    binding: Record<string, unknown>; source: { type: string; payload: { terminalEvidence?: { kind?: string; sourceId?: string }; dispatchContext?: unknown } };
    artifact: NativeCompatibilityArtifact; matches: Array<{ id: string }>; nativeSourceId: string; provider: "claude" | "codex";
  }> {
    options.assertSceneObservation(context);
    const binding = options.db.prepare("SELECT * FROM native_turn_bindings WHERE turn_id=? AND attempt_id=?").get(context.flyxTurnId, context.attemptId) as Record<string, unknown> | undefined;
    if (!binding) return fail("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    const events = options.db.prepare(`SELECT type,payload_json FROM session_events WHERE session_id=? AND type IN ('turn.completed','turn.failed','turn.cancelled')
      AND json_extract(payload_json,'$.dispatchContext.flyxTurnId')=? AND json_extract(payload_json,'$.dispatchContext.attemptId')=?`).all(context.sessionId, context.flyxTurnId, context.attemptId) as Array<{ type: string; payload_json: string }>;
    const originals = events.map((event) => ({ ...event, payload: JSON.parse(event.payload_json) as { terminalEvidence?: { kind?: string; sourceId?: string }; dispatchContext?: unknown } }))
      .filter((event) => event.payload.terminalEvidence?.kind === "native-terminal" && event.payload.terminalEvidence.sourceId && compatibilityCanonicalJson(event.payload.dispatchContext) === compatibilityCanonicalJson(context));
    if (originals.length !== 1) return fail("COMPATIBILITY_ORIGINAL_NATIVE_EVENT_MISSING");
    const artifact = options.facts.measure();
    const processes = options.db.prepare("SELECT id,state FROM managed_processes WHERE owner_id=? AND owner_generation=? AND runtime_id=? AND runtime_generation=? AND attempt_id=? AND session_id=? AND turn_id=?")
      .all(context.hostOwnerId,context.hostOwnerGeneration,context.runtimeId,context.runtimeGeneration,context.attemptId,context.sessionId,context.flyxTurnId) as Array<{ id: string; state: string }>;
    if (!processes.length || processes.some((process) => process.state !== "stopped")) return fail("COMPATIBILITY_STOP_PROOF_MISSING");
    const matches = processes.filter((process) => { const row = options.db.prepare("SELECT value_json FROM host_state WHERE key=?").get("compatibility-planned-launch/v1/" + process.id) as { value_json: string } | undefined;
      if (!row) return false; const { planned } = JSON.parse(row.value_json) as { planned: PlannedNativeArtifact };
      return planned.operation === "provider-launch" && [planned.executable,...planned.scripts].some((file) => file.path === artifact.executablePath && file.digest === artifact.executableDigest); });
    if (matches.length !== 1) return fail("COMPATIBILITY_LAUNCH_ARTIFACT_UNAVAILABLE");
    const source = originals[0]!;
    const provider = binding.provider; if (provider !== "claude" && provider !== "codex") return fail("COMPATIBILITY_NATIVE_BINDING_MISMATCH");
    return { binding, source, artifact, matches, nativeSourceId: source.payload.terminalEvidence!.sourceId!, provider };
  }
}

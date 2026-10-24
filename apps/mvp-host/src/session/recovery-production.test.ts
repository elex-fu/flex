import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateHostIdentity, publicHostIdentity, type HostIdentityFileV1 } from "../identity/host-identity.js";
import { writePrivateFile } from "../operations/operation-files.js";
import {
  CompatibilityEvidenceRecorder,
  compatibilityEvidenceArtifactDigest,
  readCompatibilityEvidence,
  type NativeCompatibilityEvidence,
} from "../diagnostics/compatibility-evidence.js";
import { importCompatibilityRun, authorizeCompatibilityRun } from "../diagnostics/compatibility-import.js";
import { COMPATIBILITY_SCENE_VERSION } from "../diagnostics/compatibility-readiness.js";
import { signCompatibilityPayload } from "../diagnostics/compatibility-integrity.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import { digest } from "../storage/recovery-store.js";
import type { AdapterEventPayload, AdapterStatus, DispatchContext, ProviderAdapter, ProviderOutcome } from "../provider/types.js";
import { fenceAdapterEvent } from "../provider/types.js";
import type { NativeHandle, NativeTurnObservation } from "../provider/native-history.js";
import { NativeHistoryReaderFactory, type ClaudeTranscriptSource } from "../provider/native-history-reader.js";
import { createNativeHistoryManifestSource } from "../provider/native-history-manifest.js";
import { SessionOrchestrator, type CommittedNativeStopRecorder } from "./orchestrator.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hex = (character: string) => character.repeat(64);

/**
 * R4 layer 4: one real end-to-end recovery chain over the production paths.
 *
 * A scene host (its own compatibility recorder bound to the recovery reader)
 * runs a real Turn whose committed native stop is recorded as turn evidence,
 * then performs a recovery inspection that is recorded as recovery evidence.
 * The source run is endorsed into a destination host, and the destination
 * host — sharing the same durable Store — reproduces the whole flow: a
 * producer-stop-unverified blockage, a trusted manifest + transcript
 * inspection through the *imported* evidence, drift fail-closed, and a final
 * reconciliation that releases the gate.
 */
describe("production recovery chain: scene run, import, destination host", () => {
  it("records, imports and recovers against the real manifest, reader and orchestrator", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-recovery-production-"));
    const workspace = realpathSync(resolve(process.cwd(), "../../packages/claude-fixtures"));
    const executable = join(root, "provider-bin");
    await writeFile(executable, "binary-content", { mode: 0o755 });

    const record: ProviderInstanceRecord = {
      providerInstanceId: "pi-1", provider: "claude", executable,
      config: { environment: {}, sandboxRequired: true }, policyVersion: 1, state: "configured",
      verification: { state: "verified", capabilities: [] }, policyCapabilities: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const configurationFingerprint = providerConfigurationFingerprint(record);
    const artifact = {
      providerVersion: "1.0.0", executablePath: executable, executableDigest: sha256("binary-content"),
      configFingerprint: configurationFingerprint, sdkVersion: "2.0.0", adapterId: "adapter", adapterVersion: "1",
      supervisionContractId: "contract-1", runtimeVersion: "1", runtimeDigest: hex("c"),
      nodeVersion: process.versions.node, os: "test os",
    };
    const source: HostIdentityFileV1 = generateHostIdentity();
    const destination: HostIdentityFileV1 = generateHostIdentity();
    const runId = "recovery-production-run";
    const entryDigest = hex("d");
    const sceneLogPath = join(root, "scene-evidence.jsonl");
    const readinessPath = join(root, "compatibility-readiness.json");
    const endorsementPath = join(root, "destination-endorsement.json");
    const importedLogPath = join(root, "imported-evidence.jsonl");
    const trimmedLogPath = join(root, "trimmed-evidence.jsonl");
    const transcript1Path = join(root, "transcript-1.jsonl");
    const transcript2Path = join(root, "transcript-2.jsonl");

    // The authorization must exist before any scene entry: the import only
    // accepts entries recorded at or after (readiness createdAt - 1s), and
    // readiness createdAt cannot precede ticket issuance.
    const authorization = authorizeCompatibilityRun(destination, {
      provider: "claude",
      artifactDigest: compatibilityEvidenceArtifactDigest({ ...artifact, provider: "claude" }),
      runtimeDigest: artifact.runtimeDigest,
      runId,
      sourceHost: publicHostIdentity(source),
      entryDigest,
    });
    const ticketIssuedAt = (authorization as unknown as { issuedAt: string }).issuedAt;

    for (const [key, value] of Object.entries({ FLYX_COMPATIBILITY_MODE: "isolated", FLYX_COMPATIBILITY_REAL_ENABLED: "1", RUN_REAL_CLAUDE: "1", RUN_REAL_CODEX: "1" })) vi.stubEnv(key, value);
    const sceneRecorder = new CompatibilityEvidenceRecorder(sceneLogPath, true, runId, {
      domain: "isolated-real", identity: source, artifact, sceneVersion: COMPATIBILITY_SCENE_VERSION, entryDigest,
      assertNativeProvenance: (evidence) => ({
        provider: evidence.provider, attemptIdHash: sha256(evidence.attemptId),
        launchRecordDigest: hex("a"), nativeObservationDigest: hex("b"),
        executableDigest: sha256("binary-content"), runtimeDigest: hex("c"),
        configFingerprint: configurationFingerprint, supervisionContractId: "contract-1",
      }),
    });

    // Real transcript files: exactly one SDK result record per native session.
    const transcripts = new Map<string, { path: string; result: Record<string, unknown> }>();
    const writeTranscript = async (path: string, nativeSessionId: string, resultUuid: string) => {
      const result = { uuid: resultUuid, type: "result", session_id: nativeSessionId, subtype: "success", is_error: false, result: "fixture result" };
      await writeFile(path, JSON.stringify(result) + "\n", { mode: 0o600 });
      transcripts.set(nativeSessionId, { path, result });
    };
    const claudeTranscriptFor = (handle: NativeHandle): ClaudeTranscriptSource | undefined => {
      const entry = transcripts.get(handle.nativeSessionId);
      if (!entry) return undefined;
      return {
        path: entry.path, format: "claude-sdk-result-v1", runtimeVersion: handle.verifiedVersion,
        sessionId: handle.sessionId, providerInstanceId: handle.providerInstanceId,
        configurationFingerprint: handle.configurationFingerprint,
        anchor: { contextDigest: digest(handle.context), resultUuid: String(entry.result.uuid), resultDigest: digest(entry.result) },
      };
    };

    const resolveResource = () => ({ provider: "claude" as const, providerInstanceId: "pi-1", workspacePath: workspace, configurationFingerprint, verifiedVersions: ["1.0.0"] });
    const supervision = () => ({ contractId: "contract-1" });
    const runtime = () => ({ providerVersion: "1.0.0", sdkVersion: "2.0.0", adapterId: "adapter", adapterVersion: "1" });
    const resolveProvider = (id: string) => (id === "pi-1" ? record : undefined);

    const sceneSource = createNativeHistoryManifestSource({
      compatibilityEvidencePath: sceneLogPath,
      supervision, runtime, resolveProvider,
      resourceFingerprint: () => ({ provider: "claude" as const, providerInstanceId: "pi-1", configurationFingerprint }),
      sceneBootstrap: () => ({ runId, entryDigest, artifact: () => ({ ...artifact }) }),
    });
    const sceneReader = new NativeHistoryReaderFactory({
      assertBinding: () => {},
      verifiedManifestForHandle: (handle) => sceneSource.verifiedManifestForHandle(handle),
      claudeTranscript: (handle) => Promise.resolve(claudeTranscriptFor(handle)),
    });

    // The scene's committed-stop recorder: turn evidence from finalization,
    // recovery evidence from the orchestrator-bound inspection wrapper.
    const turnNative = new Map<string, { nativeSessionId: string; nativeSourceId: string }>();
    const committedRecorder: CommittedNativeStopRecorder = {
      afterCommittedNativeStop: async (context) => {
        const native = turnNative.get(context.attemptId);
        if (!native) throw new Error("scene turn native identity missing");
        await sceneRecorder.record({
          provider: "claude", kind: "turn", result: "passed", nativeEvent: "result",
          evidenceCode: "NATIVE_TERMINAL_COMPLETED", nativeSessionId: native.nativeSessionId,
          nativeSourceId: native.nativeSourceId, attemptId: context.attemptId, launchRef: "launch-1",
        });
      },
      afterVerifiedRecoveryInspection: async (context, observation) => {
        const observed = observation as NativeTurnObservation & { state: "terminal" };
        await sceneRecorder.record({
          provider: "claude", kind: "recovery", result: "passed", nativeEvent: "inspect",
          evidenceCode: "NATIVE_HISTORY_INSPECT_VERIFIED", nativeSessionId: observed.nativeSessionId,
          nativeSourceId: observed.evidence.sourceId, attemptId: context.attemptId, launchRef: "recovery-inspect",
        });
      },
    };

    const adapterFor = (contexts: DispatchContext[], finishes: Array<(outcome: ProviderOutcome) => void>): ProviderAdapter => {
      const status: AdapterStatus = { provider: "claude", workspace, transport: "deterministic", adapterVersion: "fixture", executable: "fixture", runtimeVersion: "1.0.0", sandboxRequired: true };
      return {
        provider: "claude", workspace, status: async () => status, preflight: async () => status,
        runTurn: async (_turnId, _prompt, _resume, context) => {
          if (!context) throw new Error("Original context required");
          contexts.push(context);
          return new Promise<ProviderOutcome>((yes) => finishes.push(yes));
        },
        interrupt: async () => "unavailable", respondApproval: () => false,
      };
    };
    const contexts1: DispatchContext[] = [];
    const finishes1: Array<(outcome: ProviderOutcome) => void> = [];
    const contexts2: DispatchContext[] = [];
    const finishes2: Array<(outcome: ProviderOutcome) => void> = [];

    let host1: SessionOrchestrator | undefined;
    let host2: SessionOrchestrator | undefined;
    try {
      host1 = new SessionOrchestrator({
        workspace, adapter: adapterFor(contexts1, finishes1),
        canReleaseWorkspace: () => true,
        compatibilityRecorder: committedRecorder,
        recovery: {
          resolveResource: resolveResource,
          nativeHistoryReader: (handle) => sceneReader.inspect(handle, workspace),
          inspectWorkspace: async () => "clear" as const,
        },
      });
      host1.store.createDevice({ id: "device", hostId: "host", platform: "test", credentialKind: "browser-session", scopes: ["session:write"], credentialRevision: 0, createdAt: new Date().toISOString() });

      // --- Scene turn 1: a real Turn with fenced native ingest and a committed native stop.
      const sceneTurn = await host1.startTurn("device", "scene-turn-1", "scene prompt");
      await host1.worker.drainDispatch();
      const context1 = contexts1[0]!;
      turnNative.set(context1.attemptId, { nativeSessionId: "native-session-1", nativeSourceId: "native-result-1" });
      const emit1 = (payload: AdapterEventPayload) => host1!.ingestAdapterEvent(fenceAdapterEvent(context1, payload));
      emit1({ kind: "session_init", provider: "claude", providerSessionId: "native-session-1", runtimeVersion: "1.0.0", model: "fixture", tools: [] });
      emit1({ kind: "native_binding", nativeSessionId: "native-session-1", nativeTurnId: "native-turn-1" });
      await host1.ingestion.drain();
      await writeTranscript(transcript1Path, "native-session-1", "native-result-1");
      emit1({ kind: "turn_completed", result: "scene done", costUsd: 0, numTurns: 1 });
      await host1.ingestion.drain();
      finishes1[0]!({ status: "completed", providerSessionId: "native-session-1", evidence: { kind: "native-terminal", sourceId: "native-result-1" } });
      await host1.worker.drainOperations();
      expect(host1.snapshot().session).toMatchObject({ recoveryState: "idle" });
      expect(host1.snapshot().session.activeTurnId).toBeUndefined();
      expect(host1.store.getTurn(sceneTurn.turnId)?.status).toBe("completed");
      expect(readCompatibilityEvidence(sceneLogPath).entries.filter((entry) => entry.kind === "turn")).toHaveLength(1);

      // --- Scene recovery inspection: records recovery evidence through the real reader.
      host1.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
        VALUES('scene-process-1',?,?,?,?,?,?,?,NULL,NULL,'process_group','not_spawned','now')`)
        .run(context1.hostOwnerId, context1.hostOwnerGeneration, context1.runtimeId, context1.runtimeGeneration, context1.attemptId, context1.sessionId, context1.flyxTurnId);
      const handle1 = host1.recovery.recovery.nativeHandle(sceneTurn.turnId, context1.attemptId);
      expect(handle1).toMatchObject({ nativeSessionId: "native-session-1", verifiedVersion: "1.0.0", providerInstanceId: "pi-1", configurationFingerprint });
      const target1 = { sessionId: host1.sessionId, turnId: sceneTurn.turnId, attemptId: context1.attemptId };
      const view1 = await host1.recovery.inspect(target1);
      expect(view1).toMatchObject({ processState: "stopped", workspaceState: "clear", nativeState: "terminal" });
      expect(view1.nextSteps).toContain("reconcile");
      expect(readCompatibilityEvidence(sceneLogPath).entries.filter((entry) => entry.kind === "recovery")).toHaveLength(1);
      const sceneRecoveryEntry = readCompatibilityEvidence(sceneLogPath).entries.find((entry) => entry.kind === "recovery")!;

      // --- Synthetic turns to complete the 10-turn compatibility scene.
      for (let index = 2; index <= 10; index++) {
        await sceneRecorder.record({
          provider: "claude", kind: "turn", result: "passed", nativeEvent: "result",
          evidenceCode: "NATIVE_TERMINAL_COMPLETED", nativeSessionId: `scene-session-${index}`,
          nativeSourceId: `scene-result-${index}`, attemptId: `scene-attempt-${index}`, launchRef: `scene-launch-${index}`,
        } satisfies NativeCompatibilityEvidence);
      }
      expect(readCompatibilityEvidence(sceneLogPath).entries).toHaveLength(11);

      // --- Source-signed readiness, created at the authorization instant.
      const readiness = signCompatibilityPayload({
        v: 2, kind: "compatibility-readiness", domain: "isolated-real", entry: "production-main",
        runId, entryPath: join(root, "dist/main.js"), provider: "claude", buildDigest: artifact.runtimeDigest,
        entryDigest, sceneVersion: COMPATIBILITY_SCENE_VERSION, createdAt: ticketIssuedAt, observed: artifact,
      }, source);
      await writePrivateFile(readinessPath, JSON.stringify(readiness));

      // --- Fail-closed before import: no endorsed evidence exists yet.
      const preImportSource = createNativeHistoryManifestSource({
        compatibilityEvidencePath: sceneLogPath,
        compatibilityTrust: { destination: publicHostIdentity(destination), endorsementPath },
        supervision, runtime, resolveProvider,
        resourceFingerprint: () => ({ provider: "claude" as const, providerInstanceId: "pi-1", configurationFingerprint }),
      });
      expect(preImportSource.verifiedManifestForHandle(handle1!)).toBeUndefined();

      // --- Fail-closed on an incomplete scene: fewer than 10 verified turns.
      const sourceLines = (await readFile(sceneLogPath, "utf8")).split("\n").filter((line) => line.trim());
      await writePrivateFile(trimmedLogPath, sourceLines.slice(0, 3).join("\n") + "\n");
      await expect(importCompatibilityRun({
        destination, authorization, readinessPath, evidencePath: trimmedLogPath,
        endorsementPath: join(root, "trimmed-endorsement.json"), evidenceLogPath: join(root, "trimmed-imported.jsonl"),
      })).rejects.toMatchObject({ code: "COMPATIBILITY_SCENE_INCOMPLETE" });

      // --- Import the verified scene into the destination host.
      await importCompatibilityRun({ destination, authorization, readinessPath, evidencePath: sceneLogPath, endorsementPath, evidenceLogPath: importedLogPath });
      const imported = readCompatibilityEvidence(importedLogPath);
      expect(imported.available).toBe(true);
      expect(imported.entries).toHaveLength(11);
      const importedRecovery = imported.entries.find((entry) => entry.kind === "recovery");
      expect(importedRecovery?.digest).toBe(sceneRecoveryEntry.digest);
      const endorsement = JSON.parse((await readFile(endorsementPath, "utf8")).trim()) as { capabilities: string[]; recordDigests: string[] };
      // The destination endorsement must carry the recovery capability, or the
      // imported evidence could never authorize a production recovery read.
      expect(endorsement.capabilities).toContain("recovery");
      expect(endorsement.recordDigests).toContain(sceneRecoveryEntry.digest);

      // --- The production manifest now exists for the imported evidence.
      const productionSource = createNativeHistoryManifestSource({
        compatibilityEvidencePath: importedLogPath,
        compatibilityTrust: { destination: publicHostIdentity(destination), endorsementPath },
        supervision, runtime, resolveProvider,
        resourceFingerprint: (sessionId) => sessionId === host1!.sessionId ? { provider: "claude" as const, providerInstanceId: "pi-1", configurationFingerprint } : undefined,
      });
      const productionManifest = productionSource.verifiedManifestForHandle(handle1!);
      expect(productionManifest).toMatchObject({
        source: "real-provider", state: "verified", provider: "claude", providerInstanceId: "pi-1",
        configurationFingerprint, verifiedVersions: ["1.0.0"], historyContract: "claude-sdk-result-v1",
      });
      expect(productionManifest?.evidenceId).toBe(sceneRecoveryEntry.digest);
      const wrongDestination = createNativeHistoryManifestSource({
        compatibilityEvidencePath: importedLogPath,
        compatibilityTrust: { destination: publicHostIdentity(generateHostIdentity()), endorsementPath },
        supervision, runtime, resolveProvider,
        resourceFingerprint: (sessionId) => sessionId === host1!.sessionId ? { provider: "claude" as const, providerInstanceId: "pi-1", configurationFingerprint } : undefined,
      });
      expect(wrongDestination.verifiedManifestForHandle(handle1!)).toBeUndefined();

      // --- Destination host over the same durable Store, using the imported evidence.
      const productionReader = new NativeHistoryReaderFactory({
        assertBinding: () => {},
        verifiedManifestForHandle: (handle) => productionSource.verifiedManifestForHandle(handle),
        claudeTranscript: (handle) => Promise.resolve(claudeTranscriptFor(handle)),
      });
      host2 = new SessionOrchestrator({
        workspace, adapter: adapterFor(contexts2, finishes2),
        store: host1.store, owner: host1.owner, sessionId: host1.sessionId,
        ownsStore: false, recoverOnStart: false,
        canReleaseWorkspace: () => false,
        recovery: {
          resolveResource: resolveResource,
          nativeHistoryReader: (handle) => productionReader.inspect(handle, workspace),
          inspectWorkspace: async () => "clear" as const,
        },
      });

      // --- Turn 2: producer stop is unverified, so the session blocks durably.
      const productionTurn = await host2.startTurn("device", "production-turn-2", "production prompt");
      await host2.worker.drainDispatch();
      const context2 = contexts2[0]!;
      const emit2 = (payload: AdapterEventPayload) => host2!.ingestAdapterEvent(fenceAdapterEvent(context2, payload));
      emit2({ kind: "session_init", provider: "claude", providerSessionId: "native-session-2", runtimeVersion: "1.0.0", model: "fixture", tools: [] });
      emit2({ kind: "native_binding", nativeSessionId: "native-session-2", nativeTurnId: "native-turn-2" });
      await host2.ingestion.drain();
      await writeTranscript(transcript2Path, "native-session-2", "native-result-2");
      emit2({ kind: "turn_completed", result: "production done", costUsd: 0, numTurns: 1 });
      await host2.ingestion.drain();
      finishes2[0]!({ status: "completed", providerSessionId: "native-session-2", evidence: { kind: "native-terminal", sourceId: "native-result-2" } });
      await host2.worker.drainOperations();
      expect(host2.snapshot().session).toMatchObject({ activeTurnId: productionTurn.turnId, recoveryState: "blocked", activityState: "outcome_unknown" });
      expect(host2.store.getTurn(productionTurn.turnId)?.status).toBe("completed");
      await expect(host2.startTurn("device", "blocked-turn", "blocked prompt")).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });

      // --- Recovery inspection through the imported production manifest.
      host2.store.db.prepare(`INSERT INTO managed_processes(id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,process_group,tree_control,state,updated_at)
        VALUES('production-process-1',?,?,?,?,?,?,?,NULL,NULL,'process_group','not_spawned','now')`)
        .run(context2.hostOwnerId, context2.hostOwnerGeneration, context2.runtimeId, context2.runtimeGeneration, context2.attemptId, context2.sessionId, context2.flyxTurnId);
      const target2 = { sessionId: host2.sessionId, turnId: productionTurn.turnId, attemptId: context2.attemptId };
      const view2 = await host2.recovery.inspect(target2);
      expect(view2).toMatchObject({ processState: "stopped", workspaceState: "clear", nativeState: "terminal" });
      expect(view2.nextSteps).toContain("reconcile");

      // --- Drift fail-closed: a tampered transcript never reconciles.
      const original2 = transcripts.get("native-session-2")!;
      await writeFile(transcript2Path, JSON.stringify({ ...original2.result, subtype: "error_during_execution", is_error: true }) + "\n");
      await expect(host2.recovery.reconcile({ ...target2, authSubjectId: "device", commandId: "reconcile-drift",
        evidenceId: view2.evidenceId, expectedRecoveryRevision: view2.recoveryRevision })).rejects.toMatchObject({ code: "RECOVERY_EVIDENCE_STALE" });
      expect(host2.snapshot().session).toMatchObject({ activeTurnId: productionTurn.turnId, recoveryState: "blocked" });

      // --- Restored evidence reconciles and releases the gate.
      await writeFile(transcript2Path, JSON.stringify(original2.result) + "\n");
      const view2Restored = await host2.recovery.inspect(target2);
      expect(view2Restored).toMatchObject({ nativeState: "terminal" });
      const recovered = await host2.recovery.reconcile({ ...target2, authSubjectId: "device", commandId: "reconcile-production",
        evidenceId: view2Restored.evidenceId, expectedRecoveryRevision: view2Restored.recoveryRevision });
      expect(recovered).toMatchObject({ gate: "released" });
      expect(host2.snapshot().session).toMatchObject({ recoveryState: "idle" });
      expect(host2.snapshot().session.activeTurnId).toBeUndefined();
      expect(host2.store.getTurn(productionTurn.turnId)?.status).toBe("completed");

      // --- The released session accepts the next Turn.
      const next = await host2.startTurn("device", "post-recovery", "next prompt");
      expect(next.status).toBe("accepted");
      await host2.worker.drainDispatch();
    } finally {
      finishes1.forEach((finish) => finish({ status: "outcome_unknown", error: "test cleanup", evidence: { kind: "unknown", reason: "cleanup" } }));
      finishes2.forEach((finish) => finish({ status: "outcome_unknown", error: "test cleanup", evidence: { kind: "unknown", reason: "cleanup" } }));
      await host1?.worker.drainOperations();
      await host2?.worker.drainOperations();
      host2?.close();
      await host1?.closeAndWait();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});

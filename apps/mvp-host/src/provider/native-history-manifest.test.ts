import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHostIdentity } from "../identity/host-identity.js";
import { CompatibilityEvidenceRecorder } from "../diagnostics/compatibility-evidence.js";
import { providerConfigurationFingerprint } from "../lifecycle/host-activation-load.js";
import type { ProviderInstanceRecord } from "../storage/catalog-store.js";
import type { NativeHandle } from "./native-history.js";
import { createNativeHistoryManifestSource } from "./native-history-manifest.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hex = (value: string) => value.repeat(64);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(provider: "claude" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "flyx-history-manifest-"));
  roots.push(root);
  const executable = join(root, "provider-bin");
  await writeFile(executable, "binary-content", { mode: 0o755 });
  const record: ProviderInstanceRecord = {
    providerInstanceId: "pi-1", provider, executable,
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
  const handle: NativeHandle = {
    id: "handle-1", sessionId: "session-1", turnId: "turn-1", attemptId: "attempt-1", provider,
    providerInstanceId: "pi-1", nativeSessionId: "native-1", workspacePath: root,
    configurationFingerprint, verifiedVersion: "1.0.0",
    context: { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session-1", flyxTurnId: "turn-1",
      runtimeId: "runtime-1", runtimeGeneration: 1, attemptId: "attempt-1" },
    revision: 1, updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const runtime = () => ({ providerVersion: "1.0.0", sdkVersion: "2.0.0", adapterId: "adapter", adapterVersion: "1" });
  const evidencePath = join(root, "compatibility-evidence.jsonl");
  const recorderFor = (runId: string) => new CompatibilityEvidenceRecorder(evidencePath, true, runId,
    { domain: "fixture", identity: generateHostIdentity(), artifact, sceneVersion: "flyx-c3-basic-v1", entryDigest: hex("d") });
  const recordTurn = async (recorder: CompatibilityEvidenceRecorder) => recorder.record({
    provider, kind: "turn", result: "passed", nativeEvent: "result", evidenceCode: "NATIVE_TERMINAL_COMPLETED",
    nativeSessionId: "native-1", nativeTurnId: "turn-1", nativeSourceId: "source-1", attemptId: "attempt-1", launchRef: "launch-1",
  });
  const recordRecovery = async (recorder: CompatibilityEvidenceRecorder) => recorder.record({
    provider, kind: "recovery", result: "passed", nativeEvent: "inspect", evidenceCode: "NATIVE_HISTORY_INSPECT_VERIFIED",
    nativeSessionId: "native-1", nativeSourceId: "source-2", attemptId: "attempt-2", launchRef: "launch-2",
  });
  const source = (overrides?: Partial<Parameters<typeof createNativeHistoryManifestSource>[0]>) =>
    createNativeHistoryManifestSource({
      compatibilityEvidencePath: evidencePath, compatibilityTrust: { domain: "fixture" },
      supervision: () => ({ contractId: "contract-1" }), runtime,
      resolveProvider: () => record, ...overrides,
    });
  return { root, executable, record, handle, recorderFor, recordTurn, recordRecovery, source, configurationFingerprint };
}

describe("native history manifest source", () => {
  it("derives a claude manifest from a recovery read bound to the verified turn baseline", async () => {
    const f = await fixture("claude");
    await f.recordTurn(f.recorderFor("run-1"));
    await f.recordRecovery(f.recorderFor("run-1"));
    expect(f.source().verifiedManifestForHandle(f.handle)).toMatchObject({
      source: "real-provider", state: "verified", provider: "claude", providerInstanceId: "pi-1",
      configurationFingerprint: f.configurationFingerprint, verifiedVersions: ["1.0.0"],
      historyContract: "claude-sdk-result-v1",
    });
    expect(f.source().verifiedManifestForHandle(f.handle)?.evidenceId).toMatch(/^[a-f0-9]{64}$/);
  });
  it("maps a codex provider to the thread-read contract", async () => {
    const f = await fixture("codex");
    await f.recordTurn(f.recorderFor("run-1"));
    await f.recordRecovery(f.recorderFor("run-1"));
    expect(f.source().verifiedManifestForHandle(f.handle)).toMatchObject({ historyContract: "codex-thread-read-v1", provider: "codex" });
  });
  it("stays unavailable without a passed recovery entry on the same artifact", async () => {
    const f = await fixture("claude");
    await f.recordTurn(f.recorderFor("run-1"));
    expect(f.source().verifiedManifestForHandle(f.handle)).toBeUndefined();
  });
  it("rejects a recovery entry recorded in another isolated run", async () => {
    const f = await fixture("claude");
    await f.recordTurn(f.recorderFor("run-1"));
    await f.recordRecovery(f.recorderFor("run-2"));
    expect(f.source().verifiedManifestForHandle(f.handle)).toBeUndefined();
  });
  it("stays unavailable when the live executable drifted from the verified artifact", async () => {
    const f = await fixture("claude");
    await f.recordTurn(f.recorderFor("run-1"));
    await f.recordRecovery(f.recorderFor("run-1"));
    await writeFile(f.executable, "drifted-content", { mode: 0o755 });
    expect(f.source().verifiedManifestForHandle(f.handle)).toBeUndefined();
  });
  it("stays unavailable for an unresolvable provider instance", async () => {
    const f = await fixture("claude");
    await f.recordTurn(f.recorderFor("run-1"));
    await f.recordRecovery(f.recorderFor("run-1"));
    expect(f.source({ resolveProvider: () => undefined }).verifiedManifestForHandle(f.handle)).toBeUndefined();
  });
});

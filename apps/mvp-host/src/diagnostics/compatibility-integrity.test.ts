import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, chmod } from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { join } from "node:path";
import { generateHostIdentity, publicHostIdentity } from "../identity/host-identity.js";
import { CompatibilityEvidenceRecorder, loadTrustedCompatibilityEvidence, readCompatibilityEvidence, compatibilityEvidenceArtifactDigest } from "./compatibility-evidence.js";
import { compatibilityDigest, signCompatibilityPayload, verifyCompatibilityPayload } from "./compatibility-integrity.js";
import { writeCompatibilityReadiness } from "./compatibility-readiness.js";

const roots: string[] = [];
const originalArgv = [...process.argv];
afterEach(async () => { vi.unstubAllEnvs(); process.argv = [...originalArgv]; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => value.repeat(64);
const facts = { providerVersion: "1.0.0", executablePath: "/real/provider", executableDigest: hash("a"), configFingerprint: hash("b"),
  sdkVersion: "2.0.0", adapterId: "claude-sdk", adapterVersion: "1", supervisionContractId: "measured-contract", runtimeVersion: "1", runtimeDigest: hash("c"), nodeVersion: process.versions.node, os: process.platform + " " + release() + " " + arch() };
async function root() { const path = await mkdtemp(join(tmpdir(), "flyx-compatibility-")); roots.push(path); return path; }

describe("signed compatibility artifacts", () => {
  it("canonicalizes keys, binds the signer, and rejects edited facts or signatures", () => {
    const identity = generateHostIdentity();
    const signed = signCompatibilityPayload({ b: 1, a: { y: 2, x: 1 } }, identity);
    expect(compatibilityDigest({ b: 1, a: { y: 2, x: 1 } })).toBe(compatibilityDigest({ a: { x: 1, y: 2 }, b: 1 }));
    expect(verifyCompatibilityPayload(signed, publicHostIdentity(identity))).toBe(true);
    expect(verifyCompatibilityPayload({ ...signed, b: 2 })).toBe(false);
    expect(verifyCompatibilityPayload(signed, publicHostIdentity(generateHostIdentity()))).toBe(false);
    expect(compatibilityEvidenceArtifactDigest({ ...facts, provider: "claude" })).not.toBe(compatibilityEvidenceArtifactDigest({ ...facts, provider: "claude", runtimeDigest: hash("d") }));
  });
  it("accepts signed actual observations, rejects rewritten facts and excludes unsigned legacy observations from activation", async () => {
    const path = join(await root(), "native.jsonl");
    const identity = generateHostIdentity();
    const observation = { provider: "claude" as const, kind: "turn" as const, result: "passed" as const, nativeEvent: "result", evidenceCode: "NATIVE_TERMINAL_COMPLETED",
      nativeSessionId: "private-session", nativeSourceId: "private-source", attemptId: "attempt", launchRef: "launch-1" };
    const recorder = new CompatibilityEvidenceRecorder(path, true, "run-1", { domain: "fixture", identity, artifact: facts, sceneVersion: "flyx-c3-basic-v1", entryDigest: hash("d") });
    await recorder.record(observation);
    expect(loadTrustedCompatibilityEvidence(path)).toEqual([]);
    expect(loadTrustedCompatibilityEvidence(path, undefined, { domain: "fixture" })).toMatchObject([{ trusted: true, capability: "turn", sceneVersion: "flyx-c3-basic-v1", launchRef: "launch-1" }]);
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain("private-session");
    const edited = JSON.parse(serialized); edited.artifact.providerVersion = "forged";
    await writeFile(path, JSON.stringify(edited) + "\n", { mode: 0o600 });
    expect(loadTrustedCompatibilityEvidence(path, undefined, { domain: "fixture" })).toEqual([]);
    await new CompatibilityEvidenceRecorder(path, true, "run-1").record(observation);
    expect(readCompatibilityEvidence(path).entries).toHaveLength(1);
    expect(loadTrustedCompatibilityEvidence(path, undefined, { domain: "fixture" })).toEqual([]);
    await expect(recorder.record({ ...observation, nativeSourceId: undefined })).rejects.toThrow("COMPATIBILITY_NATIVE_PROOF_MISSING");
    await expect(new CompatibilityEvidenceRecorder(path, true, "run-1", { domain: "fixture", identity, artifact: { ...facts, runtimeDigest: undefined }, sceneVersion: "flyx-c3-basic-v1", entryDigest: hash("d") }).record(observation)).rejects.toThrow("COMPATIBILITY_ARTIFACT_INCOMPLETE");
  });
  it("refuses real artifact signing without matching immutable journal provenance", async () => {
    const path = join(await root(), "native.jsonl");
    for (const [key, value] of Object.entries({ FLYX_COMPATIBILITY_MODE: "isolated", FLYX_COMPATIBILITY_REAL_ENABLED: "1", RUN_REAL_CLAUDE: "1" })) vi.stubEnv(key, value);
    const context = { domain: "isolated-real" as const, identity: generateHostIdentity(), artifact: facts, sceneVersion: "flyx-c3-basic-v1", entryDigest: hash("d") };
    const evidence = { provider: "claude" as const, kind: "turn" as const, result: "passed" as const, nativeEvent: "result", evidenceCode: "NATIVE_TERMINAL_COMPLETED", nativeSessionId: "session", nativeTurnId: "turn", attemptId: "attempt", launchRef: "invented-ref" };
    await expect(new CompatibilityEvidenceRecorder(path, true, "run-1", context).record(evidence)).rejects.toThrow("COMPATIBILITY_PROVENANCE_REQUIRED");
    const assertNativeProvenance = vi.fn(() => { throw new Error("JOURNAL_MISMATCH"); });
    const recorder = new CompatibilityEvidenceRecorder(path, true, "run-1", { ...context, assertNativeProvenance });
    await expect(recorder.record(evidence)).rejects.toThrow("JOURNAL_MISMATCH");
    expect(assertNativeProvenance).toHaveBeenCalledWith(evidence, facts);
    expect(readCompatibilityEvidence(path).available).toBe(false);
    await expect(recorder.drain()).rejects.toThrow("JOURNAL_MISMATCH");
  });
  it("publishes an atomic private production handshake only under the explicit isolated real entry", async () => {
    const directory = await root();
    const entryDirectory = join(directory, "dist"); const workspace = join(directory, "workspace");
    await mkdir(entryDirectory); await mkdir(workspace); await mkdir(join(workspace, ".git"));
    const entryPath = join(entryDirectory, "main.js"); await writeFile(entryPath, "actual production build");
    const { createHash } = await import("node:crypto");
    const entryDigest = createHash("sha256").update("actual production build").digest("hex");
    process.argv[1] = entryPath;
    const options = { path: join(directory, "ready.json"), baseUrl: "http://127.0.0.1:4173", pairingToken: "s".repeat(43), provider: "claude" as const,
      identity: generateHostIdentity(), runId: "run-1", entryPath, databasePath: join(directory, "host.sqlite"), identityDirectory: join(directory, "identity"), workspace, artifact: facts, authMode: "signed_in" as const };
    await expect(writeCompatibilityReadiness(options)).rejects.toThrow("COMPATIBILITY_ENTRY_NOT_ENABLED");
    for (const [key, value] of Object.entries({ FLYX_TEST_CONTROLLED_ENTRY: "1", FLYX_COMPATIBILITY_MODE: "isolated", FLYX_COMPATIBILITY_REAL_ENABLED: "1", RUN_REAL_CLAUDE: "1", FLYX_COMPATIBILITY_ROOT: directory, FLYX_COMPATIBILITY_RUN_ID: "run-1", FLYX_COMPATIBILITY_ENTRY_DIGEST: entryDigest })) vi.stubEnv(key, value);
    await writeCompatibilityReadiness(options);
    const text = await readFile(options.path, "utf8"); const ready = JSON.parse(text);
    expect(verifyCompatibilityPayload(ready)).toBe(true); expect(ready.entry).toBe("production-main"); expect(ready.runId).toBe("run-1");
    expect(text).not.toContain(options.pairingToken); expect(text).not.toContain(options.identity.ed25519SecretKey);
    expect((await stat(options.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, ready.credentialFile))).mode & 0o777).toBe(0o600);
    await expect(writeCompatibilityReadiness({ ...options, runId: "stale-run" })).rejects.toThrow("COMPATIBILITY_RUN_MISMATCH");
    await expect(writeCompatibilityReadiness({ ...options, workspace: "/tmp" })).rejects.toThrow("COMPATIBILITY_ISOLATION_REQUIRED");
    await chmod(directory, 0o755);
    await expect(writeCompatibilityReadiness(options)).rejects.toThrow("OPERATIONS_UNSAFE_DIRECTORY");
  });
});

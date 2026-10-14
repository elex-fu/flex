import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestReadiness } from "./test-readiness.js";
import { CompatibilityEvidenceRecorder } from "./compatibility-evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("controlled test evidence", () => {
  it("publishes readiness separately from owner-only credentials", async () => {
    vi.stubEnv("FLYX_TEST_CONTROLLED_ENTRY", "1");
    const root = await mkdtemp(join(tmpdir(), "flyx-readiness-"));
    roots.push(root);
    const secret = "s".repeat(43);
    await writeTestReadiness({ path: join(root, "ready.json"), baseUrl: "http://127.0.0.1:4212", pairingToken: secret, provider: "deterministic" });
    const serialized = await readFile(join(root, "ready.json"), "utf8");
    expect(serialized).not.toContain(secret);
    const ready = JSON.parse(serialized);
    expect(await readFile(join(root, ready.credentialFile), "utf8")).toBe(secret + "\n");
    expect((await stat(join(root, "ready.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ready.credentialFile))).mode & 0o777).toBe(0o600);
  });
  it("requires an explicit controlled loopback entry and a private directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-readiness-"));
    roots.push(root);
    const options = { path: join(root, "ready.json"), baseUrl: "http://127.0.0.1:4212", pairingToken: "s".repeat(43), provider: "deterministic" as const };
    await expect(writeTestReadiness(options)).rejects.toThrow("TEST_READINESS_NOT_ENABLED");
    vi.stubEnv("FLYX_TEST_CONTROLLED_ENTRY", "1");
    await expect(writeTestReadiness({ ...options, baseUrl: "https://remote.example" })).rejects.toThrow("TEST_READINESS_LOOPBACK_REQUIRED");
    await chmod(root, 0o755);
    await expect(writeTestReadiness(options)).rejects.toThrow("OPERATIONS_UNSAFE_DIRECTORY");
    expect(await readdir(root)).toEqual([]);
  });
  it("records bounded native metadata and hashes all native identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-native-evidence-"));
    roots.push(root);
    const path = join(root, "native.jsonl");
    const recorder = new CompatibilityEvidenceRecorder(path, true, "run-1");
    await recorder.record({ provider: "codex", kind: "turn", result: "passed", nativeEvent: "turn/completed", nativeSessionId: "private-thread", nativeTurnId: "private-turn", attemptId: "attempt", evidenceCode: "NATIVE_TERMINAL_COMPLETED" });
    await recorder.drain();
    const evidence = await readFile(path, "utf8");
    expect(evidence).toContain('"source":"native"');
    expect(evidence).not.toContain("private-thread");
    expect(evidence).not.toContain("private-turn");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(recorder.record({ provider: "codex", kind: "approval", result: "passed", nativeEvent: "secret key: x", attemptId: "attempt", evidenceCode: "BAD" })).rejects.toThrow("COMPATIBILITY_EVIDENCE_INVALID");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateHostIdentity, getHostIdentityMirror, publicHostIdentity } from "../identity/host-identity.js";
import { parseCompatibilityCommand, runCompatibilityCommand } from "./compatibility-cli.js";
import { authorizeCompatibilityRun, importCompatibilityRun } from "./compatibility-import.js";
import { signCompatibilityPayload, verifyCompatibilityPayload } from "./compatibility-integrity.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => value.repeat(64);
async function root() { const value = await mkdtemp(join(tmpdir(), "flyx-compatibility-cli-")); roots.push(value); return value; }

describe("local compatibility maintenance commands", () => {
  it("strictly parses only complete known local commands", () => {
    expect(parseCompatibilityCommand(["activation", "verify"])).toBeUndefined();
    expect(parseCompatibilityCommand(["compatibility", "import", "--authorization", "/a", "--readiness", "/b", "--evidence", "/c", "--output", "/d"])).toMatchObject({ kind: "compatibility-import", evidencePath: "/c" });
    for (const args of [["compatibility"], ["compatibility", "run"], ["compatibility", "import", "--authorization", "relative"], ["compatibility", "import", "--authorization", "/a", "--readiness", "/b", "--evidence", "/c", "--output", "/d", "--output", "/e"]]) expect(() => parseCompatibilityCommand(args)).toThrow("COMPATIBILITY_COMMAND_INVALID");
  });
  it("requires the maintenance owner and identity mirror, then atomically writes a private pre-run source pin", async () => {
    const directory = await root(); const source = generateHostIdentity(); const destination = generateHostIdentity();
    const sourcePath = join(directory, "source-public.json"); await writeFile(sourcePath, JSON.stringify(publicHostIdentity(source)), { mode: 0o600 });
    const output = join(directory, "authorization.json");
    const command = parseCompatibilityCommand(["compatibility", "authorize", "--source-host", sourcePath, "--run-id", "run-1", "--provider", "claude", "--entry-digest", hash("a"), "--artifact-digest", hash("b"), "--runtime-digest", hash("c"), "--output", output])!;
    const assertActive = vi.fn(); const store = { getHostIdentityMirror: () => getHostIdentityMirror(destination) };
    await expect(runCompatibilityCommand(command, { owner: { mode: "runtime", databasePath: "/host.sqlite", assertActive }, identity: destination, store })).rejects.toThrow("COMPATIBILITY_MAINTENANCE_REQUIRED");
    await expect(runCompatibilityCommand(command, { owner: { mode: "maintenance", databasePath: "/host.sqlite", assertActive }, identity: source, store })).rejects.toThrow("COMPATIBILITY_MAINTENANCE_REQUIRED");
    await runCompatibilityCommand(command, { owner: { mode: "maintenance", databasePath: "/host.sqlite", assertActive }, identity: destination, store });
    const text = await readFile(output, "utf8"); const ticket = JSON.parse(text);
    expect(verifyCompatibilityPayload(ticket, publicHostIdentity(destination))).toBe(true);
    expect(ticket.sourceHost).toEqual(publicHostIdentity(source)); expect(ticket.provider).toBe("claude");
    expect(ticket.nonce).toHaveLength(32); expect(text).not.toContain(destination.ed25519SecretKey);
    expect((await stat(output)).mode & 0o777).toBe(0o600); expect(assertActive).toHaveBeenCalled();
  });
  it("rejects fixture-domain readiness, unpinned source identities and foreign destination authorization", async () => {
    const directory = await root(); const source = generateHostIdentity(); const destination = generateHostIdentity();
    const authorization = authorizeCompatibilityRun(destination, { provider: "claude", sourceHost: publicHostIdentity(source), runId: "run-1", entryDigest: hash("a"), artifactDigest: hash("b"), runtimeDigest: hash("c") });
    const readinessPath = join(directory, "ready.json");
    const fixture = { v: 2, domain: "fixture", entry: "production-main", entryPath: "/host/dist/main.js", provider: "claude", runId: "run-1", entryDigest: hash("a"), buildDigest: hash("c"), sceneVersion: "flyx-c3-basic-v1", createdAt: new Date().toISOString() };
    await writeFile(readinessPath, JSON.stringify(signCompatibilityPayload(fixture, source)), { mode: 0o600 });
    const options = { destination, authorization, readinessPath, evidencePath: join(directory, "native.jsonl"), endorsementPath: join(directory, "endorsement.json") };
    await expect(importCompatibilityRun(options)).rejects.toThrow("COMPATIBILITY_SOURCE_MISMATCH");
    await writeFile(readinessPath, JSON.stringify(signCompatibilityPayload(fixture, generateHostIdentity())), { mode: 0o600 });
    await expect(importCompatibilityRun(options)).rejects.toThrow("COMPATIBILITY_SOURCE_UNTRUSTED");
    await expect(importCompatibilityRun({ ...options, destination: generateHostIdentity() })).rejects.toThrow("COMPATIBILITY_AUTHORIZATION_INVALID");
    await expect(readFile(options.endorsementPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

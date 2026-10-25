import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateHostIdentity, publicHostIdentity } from "../identity/host-identity.js";
import { signCompatibilityPayload } from "../diagnostics/compatibility-integrity.js";
import { macosExecutionFactsTrust } from "./macos-managed-execution.js";
import { compatibilityEndorsementSceneVersion } from "../diagnostics/compatibility-evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: string) => value.repeat(64);
const now = Date.now();

/** A structurally valid v2 destination endorsement signed by the given host. */
function endorsementPayload(source: ReturnType<typeof generateHostIdentity>, sceneVersion: string) {
  return { v: 2, kind: "compatibility-import", domain: "destination-endorsement", sourceHost: publicHostIdentity(source),
    runId: "run-1", entryDigest: hash("a"), sceneVersion,
    authorizationDigest: hash("b"), readinessDigest: hash("c"), artifactDigest: hash("d"), evidenceSetDigest: hash("e"),
    capabilities: ["turn", "interactiveApprovals"], recordDigests: [hash("a"), hash("b")],
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() };
}

async function endorsementRoot() {
  const root = await mkdtemp(join(tmpdir(), "flyx-execution-trust-"));
  roots.push(root);
  // mkdtemp yields 0700; make the mode explicit so the parent-permission check holds everywhere.
  await chmod(root, 0o700);
  return root;
}

describe("macos execution facts trust (§6 sceneVersion threading)", () => {
  it("threads the verified destination endorsement sceneVersion into the execution facts trust", async () => {
    const directory = await endorsementRoot();
    const source = generateHostIdentity();
    const destination = generateHostIdentity();
    const endorsementPath = join(directory, "compatibility-endorsement.json");
    await writeFile(endorsementPath, JSON.stringify(signCompatibilityPayload(endorsementPayload(source, "flyx-c7-interactive-v1"), destination)), { mode: 0o600 });
    const trust = macosExecutionFactsTrust({ identity: destination, compatibilityEndorsementPath: endorsementPath });
    expect(trust.sceneVersion).toBe("flyx-c7-interactive-v1");
    expect(trust.destination).toEqual(publicHostIdentity(destination));
    expect(trust.endorsementPath).toBe(endorsementPath);
    // The threading must match the same helper the activation CLI and Host graph use.
    expect(compatibilityEndorsementSceneVersion(endorsementPath, publicHostIdentity(destination))).toBe("flyx-c7-interactive-v1");
  });

  it("drops the sceneVersion (keeping the c3 default at the usage site) for a foreign-signed endorsement", async () => {
    const directory = await endorsementRoot();
    const source = generateHostIdentity();
    const destination = generateHostIdentity();
    const endorsementPath = join(directory, "compatibility-endorsement.json");
    await writeFile(endorsementPath, JSON.stringify(signCompatibilityPayload(endorsementPayload(source, "flyx-c7-interactive-v1"), generateHostIdentity())), { mode: 0o600 });
    const trust = macosExecutionFactsTrust({ identity: destination, compatibilityEndorsementPath: endorsementPath });
    expect(trust.sceneVersion).toBeUndefined();
    // Without a threaded sceneVersion, loadTrustedCompatibilityEvidence keeps the
    // c3 default and the c7-imported activation fails closed at boot.
    expect(compatibilityEndorsementSceneVersion(endorsementPath, publicHostIdentity(destination))).toBeUndefined();
  });

  it("keeps the c3 default when the endorsement is absent or unreadable", async () => {
    const directory = await endorsementRoot();
    const destination = generateHostIdentity();
    expect(macosExecutionFactsTrust({ identity: destination, compatibilityEndorsementPath: join(directory, "compatibility-endorsement.json") }).sceneVersion).toBeUndefined();
  });

  it("rejects endorsements stored outside a 0700 directory", async () => {
    const directory = await endorsementRoot();
    await mkdir(join(directory, "shared"), { mode: 0o755 });
    const source = generateHostIdentity();
    const destination = generateHostIdentity();
    const endorsementPath = join(directory, "shared", "compatibility-endorsement.json");
    await writeFile(endorsementPath, JSON.stringify(signCompatibilityPayload(endorsementPayload(source, "flyx-c7-interactive-v1"), destination)), { mode: 0o600 });
    expect(macosExecutionFactsTrust({ identity: destination, compatibilityEndorsementPath: endorsementPath }).sceneVersion).toBeUndefined();
  });
});

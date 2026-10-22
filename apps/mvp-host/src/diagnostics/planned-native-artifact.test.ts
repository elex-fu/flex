import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedProcessRegistry } from "../lifecycle/managed-process-registry.js";
import { measurePlannedNativeArtifact } from "./planned-native-artifact.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("planned native artifact measurements", () => {
  it("journals the frozen separate snapshot before attempting an OS spawn", () => {
    const planned = measurePlannedNativeArtifact({ executable: process.execPath, args: ["--version"], cwd: process.cwd(), env: {} });
    const order: string[] = [];
    const registry = new ManagedProcessRegistry({ context: () => ({ hostOwnerId: "fixture", hostOwnerGeneration: 1, runtimeId: "fixture", runtimeGeneration: 1, attemptId: "fixture" }),
      journal: { save(record) { order.push(record.state); }, savePlannedLaunch(record, snapshot) { expect(record.state).toBe("launching"); expect(snapshot).toBe(planned); order.push("snapshot"); } },
      spawn: () => { order.push("spawn"); throw new Error("NO_OS_PROCESS_CREATED"); } });
    expect(() => registry.spawn(process.execPath, ["--version"], {}, { proof: {}, launchDigest: "a".repeat(64), plannedArtifact: planned })).toThrow("NO_OS_PROCESS_CREATED");
    expect(order).toEqual(["launching", "snapshot", "spawn", "not_spawned"]);
  });
  it("measures resolved executable, selected script, running Node/build and hashed request configuration without exposing secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flyx-planned-artifact-")); roots.push(directory);
    const script = join(directory, "provider.js"); await writeFile(script, "original bytes");
    const input = { executable: process.execPath, args: [script, "--output", join(directory, "output.js")], cwd: directory, env: { PROVIDER_SECRET: "never-export-this" } };
    const original = measurePlannedNativeArtifact(input);
    expect(original.kind).toBe("planned-native-launch"); expect(original.scripts).toHaveLength(1);
    expect(original.executable.digest).toMatch(/^[a-f0-9]{64}$/); expect(original.hostBuildDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(original)).not.toContain("never-export-this"); expect(Object.isFrozen(original)).toBe(true);
    await writeFile(script, "changed bytes");
    const changed = measurePlannedNativeArtifact(input);
    expect(changed.scripts[0]!.digest).not.toBe(original.scripts[0]!.digest); expect(changed.snapshotDigest).not.toBe(original.snapshotDigest);
    expect(measurePlannedNativeArtifact({ ...input, args: ["--eval", "console.log(1)", script] }).scripts).toEqual([]);
  });
});

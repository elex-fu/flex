import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { SqliteStore } from "../storage/db.js";
import { dispatchContextForTurn } from "./types.js";
import { ManagedRuntimeController } from "./managed-runtime.js";
import { HostManagedRuntime } from "./native-runtime-factory.js";

function readyOutput(stream: import("node:stream").Readable | null) {
  return new Promise<string>((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("Fixture child never became ready")), 2000);
    stream?.setEncoding("utf8"); stream?.on("data", (chunk: string) => { output += chunk; if (output.includes("ready")) { clearTimeout(timer); resolve(output); } }); stream?.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

describe("production Host process factory", () => {
  it("journals a real private-boundary child with original context/birth before output and never releases from root-only stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-native-factory-")); const workspace = join(root, "checkout"); const nativeState = join(root, "native-state"); const privateRoot = join(root, "host-private");
    await Promise.all([workspace, nativeState, privateRoot].map((path) => mkdir(path))); const privateFile = join(privateRoot, "state.txt"); await writeFile(privateFile, "fixture private state");
    const owner = createTestHostOwner(); const store = new SqliteStore(); const session = store.createSession(workspace, "claude");
    const host = new HostManagedRuntime({ store, owner, sessionId: session.id, runtimeId: "native-fixture", workspace, provider: "claude", nativeStateRoots: [nativeState], privateRoots: [privateRoot] }); const controller = new ManagedRuntimeController(host.options);
    try {
      const readiness = await host.prepare();
      if (process.platform === "darwin") expect(readiness.ready).toBe(true);
      const context = dispatchContextForTurn("fixture-turn", { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation, sessionId: session.id, flyxTurnId: "fixture-turn", runtimeId: "native-fixture", runtimeGeneration: 4, attemptId: "fixture-attempt" });
      if (!readiness.ready) { await expect(controller.prepare(context)).rejects.toThrow(readiness.code); expect(store.db.prepare("SELECT count(*) AS n FROM managed_processes").get()).toEqual({ n: 0 }); return; }
      if (!readiness.proof.verifiedDescendantStop) {
        // Production gate: a boundary whose proof variant does not verify
        // descendant stop never prepares a Native runtime at all; nothing is
        // journalled and no child exists to release (plan R1, pre-R0 fail-closed).
        await expect(controller.prepare(context)).rejects.toThrow("NATIVE_DESCENDANT_STOP_UNVERIFIED");
        expect(store.db.prepare("SELECT count(*) AS n FROM managed_processes").get()).toEqual({ n: 0 });
        return;
      }
      const runtime = await controller.prepare(context);
      const script = `const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(privateFile)})}catch{denied=true}process.stdout.write((denied?'denied ':'leaked ')+'ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
      const child = runtime.spawn({ command: process.execPath, args: ["-e", script], cwd: workspace, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
      expect(await readyOutput(child.stdout)).toBe("denied ready");
      const record = store.db.prepare("SELECT id,owner_id,owner_generation,runtime_id,runtime_generation,attempt_id,session_id,turn_id,pid,state FROM managed_processes WHERE attempt_id=?").get(context.attemptId) as Record<string, unknown>;
      expect(record).toMatchObject({ owner_id: owner.ownerId, owner_generation: owner.generation, runtime_id: context.runtimeId, runtime_generation: context.runtimeGeneration, attempt_id: context.attemptId, session_id: session.id, turn_id: context.flyxTurnId, pid: child.pid, state: "running" });
      expect(store.db.prepare("SELECT identity_json FROM managed_process_identities WHERE process_id=?").get(record.id)).toBeDefined(); expect(store.db.prepare("SELECT proof_json,launch_digest FROM managed_process_boundaries WHERE process_id=?").get(record.id)).toMatchObject({ proof_json: JSON.stringify(readiness.proof), launch_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const stopped = await runtime.closeAndWait(1000);
      if (!readiness.proof.verifiedDescendantStop) { expect(stopped.treeStopped).toBe(false); expect(host.canReleaseWorkspace(context)).toBe(false); expect(store.db.prepare("SELECT state FROM managed_processes WHERE id=?").get(record.id)).toEqual({ state: "unknown" }); }
      else { expect(stopped.treeStopped).toBe(true); expect(host.canReleaseWorkspace(context)).toBe(true); }
    } finally { await controller.closeAndWait(1000); await host.closeAndWait(1000); await host.disposeBoundary(); controller.sealJournals(); host.sealJournals(); store.close(); owner.release(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});

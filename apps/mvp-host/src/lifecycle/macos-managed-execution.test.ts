import { describe, expect, it } from "vitest";
import { ManagedProcessRegistry, type ManagedProcessRecord } from "./managed-process-registry.js";
import { hasValidProcessStop, processIdentityDigest, validateTreeStopEvidence } from "./managed-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "./managed-stop-contract.js";

const context = { hostOwnerId: "macos-test", hostOwnerGeneration: 1, runtimeId: "runtime", runtimeGeneration: 1, attemptId: "original-attempt" };
function registry(options: { contract?: boolean; groupExists?: () => "unknown"; strongerVerifier?: boolean } = {}) {
  const saved: ManagedProcessRecord[] = [];
  const processes = new ManagedProcessRegistry({ context: () => context, journal: { save: (record) => { saved.push(structuredClone(record)); } },
    stopMode: "managed_process_group", gracefulExitMs: 50,
    ...(options.groupExists ? { groupExists: options.groupExists } : {}),
    ...(options.strongerVerifier ? { verifyDescendantStop: (record: ManagedProcessRecord) => ({ kind: "verified-tree-stop" as const,
      sourceId: "wrong-assurance", identityDigest: processIdentityDigest(record.processIdentity!), contractId: MACOS_MANAGED_STOP_CONTRACT }) } : {}) });
  const launch = (program: string) => processes.spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] }, {
    proof: { platform: "darwin", ...(options.contract === false ? {} : { managedStopContractId: MACOS_MANAGED_STOP_CONTRACT }) }, launchDigest: "a".repeat(64),
  });
  return { processes, launch, saved };
}

describe.runIf(process.platform === "darwin")("ordinary macOS process lifecycle", () => {
  it("never upgrades the ordinary contract through an injected complete-tree callback", async () => {
    const f = registry({ strongerVerifier: true }); const child = f.launch("process.exit(0)");
    try {
      await child.waitForExit(2000); const result = await f.processes.closeAndWait(1000);
      expect(result.stopped).toBe(true); expect(result.treeStopped).toBe(false); expect(result.records[0]?.stopProof?.kind).toBe("managed-group-stop");
    } finally { await f.processes.closeAndWait(); f.processes.sealJournal(); }
  });
  it("persists an ordinary stop bound to the launch, without claiming complete descendant stop", async () => {
    const f = registry(); const child = f.launch("process.stdout.write('ready')");
    try {
      await child.waitForExit(2000);
      const result = await f.processes.closeAndWait(1500);
      expect(result.stopped).toBe(true); expect(result.treeStopped).toBe(false);
      const record = result.records[0]!;
      expect(record.stopProof?.kind).toBe("managed-group-stop"); expect(hasValidProcessStop(record)).toBe(true);
      expect(() => validateTreeStopEvidence(record.stopProof!, record.processIdentity, { ...record.boundaryEvidence!, launchDigest: "b".repeat(64) }, record.processGroup)).toThrow("PROCESS_STOP_PROOF_INVALID");
      expect(f.saved[0]?.state).toBe("launching"); expect(f.saved.at(-1)?.state).toBe("stopped");
    } finally { await f.processes.closeAndWait(2000); f.processes.sealJournal(); }
  });

  it("cleans tools remaining in the original group after the root has exited", async () => {
    const f = registry();
    const child = f.launch("require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'}).unref();");
    try {
      expect(await child.waitForExit(2000)).toBeDefined();
      // The 2s budget of the assertions below is about group cleanup semantics
      // (stopped + group gone, ordinary mode not claiming tree stop), not a
      // timing guarantee: under full-suite CPU load the SIGKILL escalation and
      // group-absence polling can exceed 2s (observed twice in full runs,
      // passes 5/5 isolated). Keep the semantics, drop the implicit clock race.
      const result = await f.processes.closeAndWait(10_000);
      expect(result.stopped).toBe(true); expect(result.treeStopped).toBe(false);
      expect(() => process.kill(-child.pid!, 0)).toThrow();
    } finally { await f.processes.closeAndWait(2000); f.processes.sealJournal(); }
  });

  it("escalates a root that ignores SIGTERM within the shared deadline", async () => {
    const f = registry(); const child = f.launch("process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},100)");
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    try { expect((await f.processes.closeAndWait(1500)).stopped).toBe(true); }
    finally { await f.processes.closeAndWait(2000); f.processes.sealJournal(); }
  });

  it("keeps an uncertain group probe and a legacy launch without the new contract unknown", async () => {
    for (const options of [{ groupExists: () => "unknown" as const }, { contract: false }]) {
      const f = registry(options); const child = f.launch("process.exit(0)");
      try {
        await child.waitForExit(2000);
        const result = await f.processes.closeAndWait(500);
        expect(result.stopped).toBe(false); expect(result.treeStopped).toBe(false);
        expect(result.records[0]?.state).toBe("unknown"); expect(result.records[0]?.stopProof).toBeUndefined();
      } finally { await f.processes.closeAndWait(2000); f.processes.sealJournal(); }
    }
  });
});

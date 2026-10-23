import { expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { arch, release } from "node:os";
import { ClaudeAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import { HostOwnerLock } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { HostManagedRuntime } from "./native-runtime-factory.js";
import { hasValidProcessStop } from "../lifecycle/managed-process-evidence.js";
import { MACOS_MANAGED_STOP_CONTRACT } from "../lifecycle/managed-stop-contract.js";
import { dispatchContextForTurn, type AdapterEvent, type AdapterStatus, type ProviderAdapter } from "./types.js";
import { installedProviderRuntimeFacts, observedProviderVersion } from "../diagnostics/compatibility-runtime-facts.js";

const enabled = new Set((process.env.RUN_REAL_MACOS_PROVIDERS ?? "").split(","));

for (const provider of ["claude", "codex"] as const) {
  it.skipIf(process.platform !== "darwin" || !enabled.has(provider))(`real macOS ${provider}: tool, new-process resume, interrupt and managed cleanup`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `flyx-managed-${provider}-`)));
    const workspace = join(root, "workspace"), data = join(root, "data"), identityDirectory = join(data, "identity");
    await mkdir(workspace); await mkdir(identityDirectory, { recursive: true });
    const owner = HostOwnerLock.acquire({ databasePath: join(data, "host.sqlite"), identityDirectory, coordinationDirectory: join(root, "coordination") });
    const store = openOwned({ databasePath: owner.databasePath, owner });
    const nonce = randomUUID();
    const events: AdapterEvent[] = [], runtimes: HostManagedRuntime[] = [], adapters: ProviderAdapter[] = [];
    const checks: string[] = [];
    let clean = true;
    let failure: unknown;
    let version: AdapterStatus | undefined;
    const bounded = async <T>(phase: string, work: Promise<T>): Promise<T> => {
      console.log(`MACOS_ACCEPTANCE ${provider} ${phase}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`ACCEPTANCE_${phase.toUpperCase()}_TIMEOUT`)), 180_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const make = () => {
      const runtimeId = `acceptance-${randomUUID()}`;
      const runtime = new HostManagedRuntime({ store, owner, sessionId: "acceptance", runtimeId, workspace, provider }); runtimes.push(runtime);
      let adapter: ProviderAdapter;
      const onEvent = (event: AdapterEvent) => {
        events.push(event);
        if (["session_init", "approval_requested", "turn_failed", "diagnostic"].includes(event.kind)) console.log(`MACOS_ACCEPTANCE_EVENT ${provider} ${event.dispatchContext.flyxTurnId} ${event.kind}${event.kind === "diagnostic" ? " " + event.code : ""}`);
        if (event.kind === "approval_requested") adapter.respondApproval(event.request.approvalId, "allow_once");
      };
      adapter = provider === "claude" ? new ClaudeAdapter({ ...runtime.options, workspace, onEvent, maxBudgetUsd: 0.5,
        ...(process.env.FLYX_CLAUDE_EXECUTABLE ? { executable: process.env.FLYX_CLAUDE_EXECUTABLE } : {}) })
        : new CodexAdapter({ ...runtime.options, workspace, onEvent, effort: "low", ...(process.env.FLYX_CODEX_EXECUTABLE ? { executable: process.env.FLYX_CODEX_EXECUTABLE } : {}) });
      adapters.push(adapter);
      const context = (turn: string) => dispatchContextForTurn(turn, { hostOwnerId: owner.ownerId, hostOwnerGeneration: owner.generation,
        runtimeId, runtimeGeneration: 1, sessionId: "acceptance", flyxTurnId: turn, attemptId: randomUUID() });
      return { runtime, adapter, context };
    };
    try {
      const first = make();
      const readiness = await first.runtime.prepare();
      expect(readiness.ready).toBe(true);
      if (!readiness.ready) throw new Error(readiness.code);
      expect(readiness.proof.managedStopContractId).toBe(MACOS_MANAGED_STOP_CONTRACT);
      expect(readiness.proof.verifiedDescendantStop).toBe(false);
      version = await bounded("version", provider === "codex" ? first.adapter.preflight() : first.adapter.status());
      expect(version.provider).toBe(provider); checks.push("managed-version-query");
      const original = first.context("write");
      const outcome = await bounded("write", first.adapter.runTurn("write", `Use the shell exactly once to run \`printf '%s' '${nonce}' > proof.txt\`. Work only in the current directory. Then reply FLYX_WRITE_OK.`, undefined, original));
      expect(outcome.status).toBe("completed");
      expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe(nonce);
      expect(events.some((event) => event.kind === "tool_started")).toBe(true);
      if (provider === "claude") {
        const bash = events.filter((event) => event.kind === "tool_started" && event.toolName === "Bash").map((event) => event.kind === "tool_started" ? event.toolUseId : "");
        expect(events.some((event) => event.kind === "tool_completed" && bash.includes(event.toolUseId) && !event.error && !/sandbox_apply|Exit code [1-9]/.test(event.output ?? ""))).toBe(true);
        expect(events.some((event) => event.kind === "tool_started" && ["Edit", "Write"].includes(event.toolName))).toBe(false);
      }
      const nativeId = "providerSessionId" in outcome ? outcome.providerSessionId : undefined;
      expect(nativeId).toBeTruthy(); checks.push("native-tool-and-file");
      const stopped = await first.adapter.closeTurnAndWait!(original, 5000);
      expect(stopped.stopped).toBe(true); expect(stopped.treeStopped).toBe(false);
      expect(stopped.records.length).toBeGreaterThan(0); expect(stopped.records.every(hasValidProcessStop)).toBe(true);
      await first.adapter.closeAndWait!(5000); checks.push("original-process-stopped");
      const originalPids = stopped.records.map((record) => record.pid);

      const resumed = make(); const resumedContext = resumed.context("resume");
      const followup = await bounded("resume", resumed.adapter.runTurn("resume", "Read proof.txt using a tool and reply with its exact contents. Do not change files.", nativeId, resumedContext));
      expect(followup.status).toBe("completed");
      expect("providerSessionId" in followup && followup.providerSessionId).toBe(nativeId);
      expect(events.some((event) => event.kind === "assistant_message" && event.dispatchContext.flyxTurnId === "resume" && event.text.includes(nonce))).toBe(true);
      const resumedStop = await resumed.adapter.closeTurnAndWait!(resumedContext, 5000);
      expect(resumedStop.stopped).toBe(true); expect(resumedStop.treeStopped).toBe(false);
      expect(resumedStop.records.some((record) => record.pid && !originalPids.includes(record.pid))).toBe(true);
      checks.push("cross-process-native-resume");

      const interruption = resumed.context("interrupt");
      const inflight = resumed.adapter.runTurn("interrupt", "Use Bash exactly once to run `printf running > interrupt-started.txt; sleep 60`. Do not use any other tool. After the command returns reply FLYX_SLEEP_DONE.", nativeId, interruption);
      const until = Date.now() + 180_000;
      let waitingForMarker = true;
      try { await bounded("interrupt_running", Promise.race([
        (async () => {
          while (waitingForMarker && Date.now() < until) {
            try { if ((await readFile(join(workspace, "interrupt-started.txt"), "utf8")) === "running") return; } catch { /* Wait for the actual tool side effect. */ }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error("INTERRUPT_COMMAND_NOT_STARTED");
        })(),
        inflight.then(() => { throw new Error("INTERRUPT_TURN_ENDED_BEFORE_OBSERVATION"); }),
      ])); } finally { waitingForMarker = false; }
      await resumed.adapter.interrupt("acceptance");
      const cancelled = await bounded("interrupt", inflight);
      expect(cancelled.status).toBe("cancelled");
      const interruptStop = await resumed.adapter.closeTurnAndWait!(interruption, 5000);
      expect(interruptStop.stopped).toBe(true); expect(interruptStop.treeStopped).toBe(false);
      expect(interruptStop.records.every(hasValidProcessStop)).toBe(true);
      checks.push("native-interrupt-and-cleanup");
    } catch (error) { failure = error; }
    finally {
      for (const adapter of adapters) { try { const report = await adapter.closeAndWait!(5000); clean &&= report.stopped; } catch { clean = false; } }
      for (const runtime of runtimes) { try { const report = await runtime.closeAndWait(5000); clean &&= report.stopped; await runtime.disposeBoundary(); } catch { clean = false; } runtime.sealJournals(); }
      const journal = store.db.prepare("SELECT state,COUNT(*) AS count FROM managed_processes GROUP BY state").all();
      const planned = (store.db.prepare("SELECT value_json FROM host_state WHERE key LIKE 'compatibility-planned-launch/v1/%'").all() as { value_json: string }[])
        .map((row) => (JSON.parse(row.value_json) as { planned: { hostBuildDigest: string; executable: { path: string; digest: string }; snapshotDigest: string } }).planned);
      const report = { provider, at: new Date().toISOString(), node: process.version, platform: process.platform, os: `${process.platform} ${release()} ${arch()}`,
        ...(version ? { runtime: installedProviderRuntimeFacts(provider, observedProviderVersion(version.runtimeVersion)) } : {}),
        launchSnapshots: planned.map((value) => ({ hostBuildDigest: value.hostBuildDigest, executableDigest: value.executable.digest, snapshotDigest: value.snapshotDigest })),
        stopRecords: (store.db.prepare("SELECT p.id,p.attempt_id,b.launch_digest,s.proof_json FROM managed_processes p LEFT JOIN managed_process_boundaries b ON b.process_id=p.id LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id").all() as { id: string; attempt_id: string; launch_digest: string; proof_json: string | null }[])
          .map((row) => ({ processHash: createHash("sha256").update(row.id).digest("hex"), attemptHash: createHash("sha256").update(row.attempt_id).digest("hex"), launchDigest: row.launch_digest,
            stopDigest: row.proof_json ? createHash("sha256").update(row.proof_json).digest("hex") : null, stopKind: row.proof_json ? JSON.parse(row.proof_json).kind : null })),
        contractId: MACOS_MANAGED_STOP_CONTRACT, checks, clean, journal, result: !failure && clean ? "passed" : "failed",
        diagnostics: events.filter((event) => event.kind === "diagnostic").map((event) => event.kind === "diagnostic" ? event.code : ""),
        errors: events.flatMap((event) => event.kind === "diagnostic" ? [{ kind: event.code, message: event.message.slice(0, 1024) }]
          : event.kind === "tool_completed" ? [{ kind: "tool", message: (event.error ?? event.output ?? "").slice(0, 1024) }] : []),
        failure: failure instanceof Error ? failure.message.slice(0, 256) : failure ? "acceptance_failed" : undefined };
      if (process.env.FLYX_ACCEPTANCE_REPORT_DIR) { await mkdir(process.env.FLYX_ACCEPTANCE_REPORT_DIR, { recursive: true }); await writeFile(join(process.env.FLYX_ACCEPTANCE_REPORT_DIR, `${provider}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
      store.close();
      if (clean) { owner.release(); await rm(root, { recursive: true, force: true }); }
      else { owner.retain("acceptance_requires_inspection"); owner.release(); console.error(`ACCEPTANCE_RETAINED ${provider}: ${root}`); }
    }
    if (failure) throw failure;
    expect(clean).toBe(true);
  }, 600_000);
}

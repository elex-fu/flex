import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SpawnOptions as SdkSpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import { ManagedProcessRegistry, processIdentityDigest, type ManagedProcessRecord, type ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { ManagedRuntimeController, type ManagedRuntimeOptions, type NativeSpawnRequest } from "./managed-runtime.js";
import type { AdapterEvent, DispatchContext } from "./types.js";

const workspace = resolve(process.cwd(), "../../packages/claude-fixtures");
const context: DispatchContext = { hostOwnerId: "fixture-owner", hostOwnerGeneration: 2, sessionId: "fixture-session", flyxTurnId: "fixture-turn", runtimeId: "fixture-runtime", runtimeGeneration: 3, attemptId: "fixture-attempt" };
const init = { type: "system", subtype: "init", session_id: "native-session", claude_code_version: "fixture", model: "fixture", tools: [] } as unknown as SDKMessage;
const result = { type: "result", uuid: "native-result-uuid", subtype: "success", session_id: "native-session", result: "done", total_cost_usd: 0, num_turns: 1 } as unknown as SDKMessage;
function barrier() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
function managed(spawnChild?: (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => ChildProcess) {
  const records: ManagedProcessRecord[] = []; const stops: Array<{ context: DispatchContext; result: ProcessStopResult }> = [];
  const options: ManagedRuntimeOptions = {
    executionBoundary: async () => ({ ready: true, proof: { verifiedPrivateReadBoundary: true, verifiedDescendantStop: true }, boundary: { spawn: (registry, request: NativeSpawnRequest) => { const { command, args, ...options } = request; return registry.spawn(command, args, options, { proof: { fixture: true }, launchDigest: "a".repeat(64) }); } } }),
    processRegistryFactory: (fixed) => new ManagedProcessRegistry({ journal: { save: (record) => records.push(structuredClone(record)) }, context: () => fixed,
      ...(spawnChild ? { spawn: spawnChild as unknown as typeof spawn } : {}), groupExists: () => "absent", identify: (pid) => ({ pid, platform: "linux", birth: { kind: "linux", bootId: "12345678-1234-1234-1234-123456789abc", startTicks: "10" } }),
      verifyDescendantStop: (record) => ({ kind: "verified-tree-stop", sourceId: "controlled-exit", contractId: "fixture-tree-contract", identityDigest: processIdentityDigest(record.processIdentity!) }) }),
    onProcessStop: (context, result) => stops.push({ context, result }),
  };
  return { options, records, stops };
}

describe("managed SDK runtime integration", () => {
  it("preserves SDK command/argv/cwd/env and its forwarded signal, journals before spawn, and waits for producer proof", async () => {
    const child = new EventEmitter() as ChildProcess; const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough(); const kill = vi.fn(() => true);
    Object.assign(child, { pid: 5_000_000, stdin, stdout, stderr, kill, exitCode: null, signalCode: null, killed: false }); stdin.once("finish", () => child.emit("exit", 0, null));
    const forwarded = new AbortController(); const sdkRequest: SdkSpawnOptions = { command: "fixture-sdk-executable", args: ["--original", "space value"], cwd: workspace, env: { PATH: "fixture-path", SDK_AUTH: "fixture-auth" }, signal: forwarded.signal };
    let captured: { command: string; args: readonly string[]; options: import("node:child_process").SpawnOptions } | undefined;
    const f = managed((command, args, options) => { expect(f.records.at(-1)).toMatchObject({ state: "launching", ...context, boundaryEvidence: { launchDigest: "a".repeat(64) } }); captured = { command, args, options }; return child; });
    const events: AdapterEvent[] = [];
    const queryFactory = ((request) => { const process = request.options?.spawnClaudeCodeProcess?.(sdkRequest); expect(process).not.toBe(child); expect(process?.stdin).toBe(stdin); expect(process?.stdout).toBe(stdout); return { async *[Symbol.asyncIterator]() { yield init; yield result; }, interrupt: async () => {}, close: () => { stdin.end(); } } as unknown as Query; }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    try {
      expect(await adapter.runTurn(context.flyxTurnId, "task", undefined, context)).toMatchObject({ status: "completed", evidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
      expect(captured).toMatchObject({ command: sdkRequest.command, args: sdkRequest.args, options: { cwd: workspace, env: sdkRequest.env } }); expect(captured?.options.signal).toBe(forwarded.signal); expect(forwarded.signal.aborted).toBe(false); expect(kill).not.toHaveBeenCalled();
      expect(f.records.at(-1)?.state).toBe("stopped"); expect(f.stops.at(-1)).toMatchObject({ context, result: { treeStopped: true } }); expect(events.at(-1)).toMatchObject({ kind: "turn_completed", dispatchContext: context, terminalEvidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
    } finally { await adapter.closeAndWait(); adapter.sealCallbacks(); adapter.sealProcessJournal(); }
  });
  it("fails closed when a launch is rejected before any OS process exists", async () => {
    const f = managed(() => { throw new Error("ENOENT"); }); const events: AdapterEvent[] = []; const failures: Error[] = [];
    const sdkRequest: SdkSpawnOptions = { command: "fixture-sdk-executable", args: [], cwd: workspace, env: {}, signal: new AbortController().signal };
    const queryFactory = ((request) => {
      const process = request.options?.spawnClaudeCodeProcess?.(sdkRequest);
      // The locked SDK registers its own error handler synchronously right after the callback.
      process?.on("error", (error) => failures.push(error));
      if (process) {
        expect(process.stdin).toBeDefined(); expect(process.stdout).toBeDefined();
        expect(process.killed).toBe(false); expect(process.exitCode).toBeNull(); expect(process.signalCode).toBeNull();
        expect(process.kill("SIGTERM")).toBe(false);
      }
      return { async *[Symbol.asyncIterator]() { yield init; }, close() {}, interrupt: async () => {} } as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    try {
      expect(await adapter.runTurn(context.flyxTurnId, "task", undefined, context)).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } });
      expect(failures.map((error) => error.message)).toEqual(["ENOENT"]);
      expect(f.records.map((record) => record.state)).toEqual(["launching", "not_spawned"]);
      expect(f.records.at(-1)?.errorCode).toBe("SPAWN_THROW");
      expect(events.some((event) => ["turn_completed", "turn_failed", "turn_cancelled"].includes(event.kind))).toBe(false);
    } finally { await adapter.closeAndWait(); }
  });
  it("snapshots controlled Provider model, executable and allowlisted environment", async () => {
    const environment = { PATH: "registered-path", LANG: "C" }; let configured: unknown;
    const queryFactory = ((request) => { configured = request.options; return { async *[Symbol.asyncIterator]() { yield init; yield result; }, close() {}, interrupt: async () => {} } as unknown as Query; }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...managed().options, workspace, executable: "registered-cli", model: "registered-model", environment, queryFactory }); environment.PATH = "later-untrusted-path";
    try { expect(await adapter.runTurn(context.flyxTurnId, "task", undefined, context)).toMatchObject({ status: "completed" }); expect(configured).toMatchObject({ pathToClaudeCodeExecutable: "registered-cli", model: "registered-model", env: { PATH: "registered-path", LANG: "C" } }); }
    finally { await adapter.closeAndWait(); }
    for (const Adapter of [ClaudeAdapter, CodexAdapter]) {
      expect(() => new Adapter({ workspace, environment: { NODE_OPTIONS: "--require private-loader" } })).toThrow("PROVIDER_ENVIRONMENT_INVALID");
      expect(() => new Adapter({ workspace, environment: { PATH: "bad\0value" } })).toThrow("PROVIDER_ENVIRONMENT_INVALID");
    }
  });
  it("treats an iterator error after possible send as unknown without manufacturing a failure terminal", async () => {
    const f = managed(); const events: AdapterEvent[] = [];
    const queryFactory = (() => ({ async *[Symbol.asyncIterator]() { yield init; throw new Error("stream lost after possible send"); }, close() {}, interrupt: async () => {} })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    try { expect(await adapter.runTurn(context.flyxTurnId, "task", undefined, context)).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } }); expect(events.some((event) => ["turn_failed", "turn_cancelled", "turn_completed"].includes(event.kind))).toBe(false); }
    finally { await adapter.closeAndWait(); }
  });
  it("requires a native result after interrupt delivery, even when the SDK iterator ends cleanly", async () => {
    const f = managed(); const started = barrier(); const ended = barrier(); const events: AdapterEvent[] = [];
    const queryFactory = (() => ({ async *[Symbol.asyncIterator]() { yield init; started.resolve(); await ended.promise; }, close() {}, interrupt: async () => {} })) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    try { const turn = adapter.runTurn(context.flyxTurnId, "task", undefined, context); await started.promise; expect(await adapter.interrupt()).toBe("accepted"); ended.resolve(); expect(await turn).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } }); expect(events.some((event) => event.kind === "turn_cancelled")).toBe(false); }
    finally { ended.resolve(); await adapter.closeAndWait(); }
  });
  it("re-delivers an acknowledged-but-ignored interrupt until the CLI aborts, mapping the abort to a cancelled turn", async () => {
    // Ground truth from claude-cli 2.1.216 / claude-agent-sdk 0.3.220: an
    // interrupt delivered during the CLI's init phase is acknowledged without
    // being acted on, and the turn runs to natural completion.  The adapter
    // must keep re-delivering so a decided interrupt still sticks.
    const f = managed(); const events: AdapterEvent[] = []; const ready = barrier(); const acted = barrier();
    let deliveries = 0;
    const queryFactory = (() => ({
      async *[Symbol.asyncIterator]() { yield init; ready.resolve(); await acted.promise; yield { ...result, terminal_reason: "aborted_streaming" } as unknown as SDKMessage; },
      close() {},
      interrupt: async () => { deliveries++; if (deliveries >= 3) acted.resolve(); },
    }) as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    vi.useFakeTimers();
    try {
      const turn = adapter.runTurn(context.flyxTurnId, "task", undefined, context);
      await ready.promise;
      expect(await adapter.interrupt()).toBe("accepted");
      expect(deliveries).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000); // init-phase redelivery: still ignored
      expect(deliveries).toBe(2);
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000); // second redelivery acts: the CLI aborts the stream
      expect(deliveries).toBe(3);
      expect(await turn).toMatchObject({ status: "cancelled", evidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
      expect(events.some((event) => event.kind === "turn_cancelled")).toBe(true);
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(false);
    } finally { vi.useRealTimers(); acted.resolve(); await adapter.closeAndWait(); }
  });
  it("keeps re-delivering while an earlier interrupt() delivery hangs, and does not report INTERRUPT_UNCONFIRMED at 5s", async () => {
    // r12 evidence: a retry delivery's interrupt() promise never settled
    // (the CLI init phase ignores the control request), which stalled the
    // retry chain and let the legacy 5s confirm timer fire INTERRUPT_UNCONFIRMED
    // at ~6s.  The loop must keep ticking and a later delivery must still win.
    const f = managed(); const events: AdapterEvent[] = []; const ready = barrier(); const acted = barrier();
    let deliveries = 0;
    const queryFactory = (() => ({
      async *[Symbol.asyncIterator]() { yield init; ready.resolve(); await acted.promise; yield { ...result, terminal_reason: "aborted_streaming" } as unknown as SDKMessage; },
      close() {},
      interrupt: () => {
        deliveries++;
        if (deliveries === 2) return new Promise<void>(() => {}); // hung control request
        if (deliveries >= 3) acted.resolve();
        return Promise.resolve();
      },
    }) as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    vi.useFakeTimers();
    try {
      const turn = adapter.runTurn(context.flyxTurnId, "task", undefined, context);
      await ready.promise;
      expect(await adapter.interrupt()).toBe("accepted");
      await vi.advanceTimersByTimeAsync(6_000); // past the old 5s confirm deadline, with one delivery hung
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(false);
      expect(deliveries).toBe(3); // ticks continued past the hung delivery until the CLI aborted
      expect(await turn).toMatchObject({ status: "cancelled", evidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
      expect(events.some((event) => event.kind === "turn_cancelled")).toBe(true);
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(false);
    } finally { vi.useRealTimers(); acted.resolve(); await adapter.closeAndWait(); }
  });
  it("stops re-delivering after the interrupt retry window and reports INTERRUPT_UNCONFIRMED", async () => {
    const f = managed(); const events: AdapterEvent[] = []; const ready = barrier(); const closed = barrier();
    let deliveries = 0;
    const queryFactory = (() => ({
      async *[Symbol.asyncIterator]() { yield init; ready.resolve(); await closed.promise; },
      close() { closed.resolve(); },
      interrupt: async () => { deliveries++; },
    }) as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    vi.useFakeTimers();
    try {
      const turn = adapter.runTurn(context.flyxTurnId, "task", undefined, context);
      await ready.promise;
      expect(await adapter.interrupt()).toBe("accepted");
      await vi.advanceTimersByTimeAsync(59_000);
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(false);
      expect(deliveries).toBeGreaterThan(3);
      await vi.advanceTimersByTimeAsync(2_000); // window exhausted: backstop closes the query
      expect(await turn).toMatchObject({ status: "outcome_unknown", evidence: { kind: "unknown" } });
      expect(events.some((event) => event.kind === "diagnostic" && event.code === "INTERRUPT_UNCONFIRMED")).toBe(true);
    } finally { vi.useRealTimers(); closed.resolve(); await adapter.closeAndWait(); }
  });
  it("refuses a private-read-only boundary without descendant stop before creating any production registry", async () => {
    const factory = vi.fn(() => { throw new Error("must not create registry"); });
    const controller = new ManagedRuntimeController({ processRegistryFactory: factory, executionBoundary: async () => ({
      ready: true, proof: { verifiedPrivateReadBoundary: true, verifiedDescendantStop: false }, boundary: { spawn: () => { throw new Error("must not spawn"); } },
    }) });
    await expect(controller.prepare(context)).rejects.toThrow("NATIVE_DESCENDANT_STOP_UNVERIFIED");
    expect(factory).not.toHaveBeenCalled(); expect(await controller.closeAndWait()).toMatchObject({ stopped: true, treeStopped: true, records: [] });
  });
  it("prevents a delayed boundary preparation from launching after close", async () => {
    const ready = barrier(); let factories = 0;
    const controller = new ManagedRuntimeController({ ...managed().options, executionBoundary: async () => { await ready.promise; return { ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", summary: "unavailable" }; }, processRegistryFactory: () => { factories++; throw new Error("must not construct"); } });
    const preparing = controller.prepare(context); const rejection = expect(preparing).rejects.toThrow("RUNTIME_CLOSING"); await controller.closeAndWait(); ready.resolve(); await rejection; expect(factories).toBe(0);
  });
});

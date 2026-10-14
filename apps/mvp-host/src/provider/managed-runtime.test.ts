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
    executionBoundary: async () => ({ ready: true, proof: { verifiedPrivateReadBoundary: true, verifiedDescendantStop: false }, boundary: { spawn: (registry, request: NativeSpawnRequest) => { const { command, args, ...options } = request; return registry.spawn(command, args, options, { proof: { fixture: true }, launchDigest: "a".repeat(64) }); } } }),
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
    const queryFactory = ((request) => { const process = request.options?.spawnClaudeCodeProcess?.(sdkRequest); expect(process).toBe(child); return { async *[Symbol.asyncIterator]() { yield init; yield result; }, interrupt: async () => {}, close: () => { stdin.end(); } } as unknown as Query; }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = new ClaudeAdapter({ ...f.options, workspace, queryFactory, onEvent: (event) => events.push(event) });
    try {
      expect(await adapter.runTurn(context.flyxTurnId, "task", undefined, context)).toMatchObject({ status: "completed", evidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
      expect(captured).toMatchObject({ command: sdkRequest.command, args: sdkRequest.args, options: { cwd: workspace, env: sdkRequest.env } }); expect(captured?.options.signal).toBe(forwarded.signal); expect(forwarded.signal.aborted).toBe(false); expect(kill).not.toHaveBeenCalled();
      expect(f.records.at(-1)?.state).toBe("stopped"); expect(f.stops.at(-1)).toMatchObject({ context, result: { treeStopped: true } }); expect(events.at(-1)).toMatchObject({ kind: "turn_completed", dispatchContext: context, terminalEvidence: { kind: "native-terminal", sourceId: "native-result-uuid" } });
    } finally { await adapter.closeAndWait(); adapter.sealCallbacks(); adapter.sealProcessJournal(); }
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
  it("prevents a delayed boundary preparation from launching after close", async () => {
    const ready = barrier(); let factories = 0;
    const controller = new ManagedRuntimeController({ ...managed().options, executionBoundary: async () => { await ready.promise; return { ready: false, code: "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE", summary: "unavailable" }; }, processRegistryFactory: () => { factories++; throw new Error("must not construct"); } });
    const preparing = controller.prepare(context); const rejection = expect(preparing).rejects.toThrow("RUNTIME_CLOSING"); await controller.closeAndWait(); ready.resolve(); await rejection; expect(factories).toBe(0);
  });
});

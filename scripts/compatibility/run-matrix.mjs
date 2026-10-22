#!/usr/bin/env node
/** Controlled compatibility evidence. Real calls require --real AND RUN_REAL_<PROVIDER>=1. */
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compatibilitySceneCommandIds, environmentMatches, evaluateVerification, parseArgs, parseNativeEvidence, readPrivateArtifact, readReadiness } from "./evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCENE_VERSION = "flyx-c3-basic-v1";
const BASIC_PROMPT = "回复 OK 两个字母，不要做任何其他事";
const TERMINALS = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
const USAGE = "node scripts/compatibility/run-matrix.mjs [--prepare | --deterministic-only | --real] [--run-id id] [--combo id] [--turns 1-100] [--config path] [--evidence-root path]\nReal calls also require RUN_REAL_CLAUDE=1 or RUN_REAL_CODEX=1. Existing authentication and built artifacts are required.\n";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const code = (error) => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : "MATRIX_OPERATION_FAILED";
const coded = (value) => Object.assign(new Error(value), { code: value });
const log = (value) => process.stdout.write("[matrix] " + value + "\n");

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}
async function waitForReady(child, path, expected, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw coded("HOST_EXITED_BEFORE_READY");
    try { return await readReadiness(path, { ...expected, expectedPid: child.pid }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw coded("HOST_READY_TIMEOUT");
}
async function stopHost(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return { status: "already_exited", code: child.exitCode };
  let forced = false;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 10_000);
  await exited;
  clearTimeout(timer);
  return { status: forced ? "forced" : "graceful", code: child.exitCode };
}
async function startHost({ layer, combo, scratch, nativePath, runId }) {
  const controlled = join(scratch, layer);
  await mkdir(controlled, { recursive: true, mode: 0o700 });
  await chmod(controlled, 0o700);
  await mkdir(join(controlled, "web"), { mode: 0o700 });
  const readinessPath = join(controlled, "ready.json");
  const workspace = join(controlled, "workspace");
  await cp(join(ROOT, "packages/claude-fixtures"), workspace, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".git") });
  const git = promisify(execFile);
  await git("git", ["init", "--quiet", workspace]);
  await git("git", ["-C", workspace, "add", "."]);
  await git("git", ["-C", workspace, "-c", "user.name=Flyx compatibility", "-c", "user.email=compatibility@localhost", "commit", "--quiet", "-m", "isolated compatibility fixture"]);
  const real = layer === "real";
  if (real && (!combo.authorizationPath || !combo.destinationHostPath)) throw coded("MATRIX_PREAUTHORIZED_RUN_REQUIRED");
  const entryPath = real ? await realpath(join(ROOT, "apps/mvp-host/dist/main.js")) : undefined;
  const entryDigest = real ? hash(await readFile(entryPath)) : undefined;
  const expectedHost = real ? JSON.parse(await readPrivateArtifact(join(dirname(nativePath), "source-host.json"))) : undefined;
  const startedAt = Date.now();
  const provider = combo.provider ?? "claude";
  const child = spawn(process.execPath, real ? [join(ROOT, "apps/mvp-host/dist/main.js")] : ["--import", "tsx", "src/test-support/e2e-main.ts"], {
    cwd: join(ROOT, "apps/mvp-host"),
    env: {
      ...process.env, PORT: "0", FLYX_PROVIDER: provider, FLYX_WORKSPACE: workspace,
      FLYX_DB: join(controlled, "host.sqlite"), FLYX_IDENTITY_DIR: join(controlled, "identity"),
      FLYX_E2E_ROOT: join(controlled, "e2e"), FLYX_WEB_ROOT: join(controlled, "web"),
      FLYX_ALLOW_INSECURE_HTTP: "1", FLYX_REQUIRE_PAIRING_CONFIRM: "0",
      FLYX_CONNECTIVITY_MODE: "local", FLYX_RELAY_ENABLED: "0", FLYX_PUBLIC_BASE_URL: "", FLYX_SKIP_PREFLIGHT: "0",
      FLYX_TEST_CONTROLLED_ENTRY: "1", FLYX_TEST_READINESS_PATH: readinessPath, FLYX_COMPATIBILITY_READINESS_PATH: readinessPath,
      FLYX_COMPATIBILITY_EVIDENCE_PATH: nativePath, FLYX_COMPATIBILITY_RUN_ID: runId,
      FLYX_COMPATIBILITY_MODE: "isolated", FLYX_COMPATIBILITY_ROOT: controlled,
      FLYX_COMPATIBILITY_AUTHORIZATION_PATH: combo.authorizationPath ?? "", FLYX_COMPATIBILITY_DESTINATION_HOST_PATH: combo.destinationHostPath ?? "",
      FLYX_COMPATIBILITY_REAL_ENABLED: real ? "1" : "0", FLYX_COMPATIBILITY_ENTRY_DIGEST: entryDigest ?? "",
      ...(provider === "claude" ? { FLYX_CLAUDE_EXECUTABLE: combo.executableSource === "sdk-bundled" ? "" : combo.executablePath ?? "claude" } : { FLYX_CODEX_EXECUTABLE: combo.executablePath ?? "codex" }),
    }, stdio: ["ignore", "ignore", "ignore"],
  });
  let spawnError;
  child.once("error", () => { spawnError = coded("HOST_SPAWN_FAILED"); });
  try {
    const info = await waitForReady(child, readinessPath, { expectedProvider: real ? provider : "deterministic", expectedRunId: runId, expectedEntryDigest: entryDigest, expectedEntryPath: entryPath, expectedHost, startedAt }, real ? 180_000 : 60_000);
    if (spawnError) throw spawnError;
    if (info.pid !== child.pid) throw coded("READINESS_PID_MISMATCH");
    return { child, info };
  } catch (error) { await stopHost(child); throw spawnError ?? error; }
}
export class RpcClient {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.waiters = new Set(); this.events = [];
    ws.onmessage = (message) => { try { this.handleFrame(JSON.parse(typeof message.data === "string" ? message.data : "")); } catch {} };
    ws.onclose = () => { for (const settle of this.pending.values()) settle({ ok: false, error: { code: "WS_CLOSED" } }); this.pending.clear(); };
  }
  handleFrame(frame) {
    if (frame?.type === "response") { const settle = this.pending.get(frame.id); if (settle) { this.pending.delete(frame.id); settle(frame); } }
    if (frame?.type === "event") {
      this.events.push(frame.event); if (this.events.length > 1024) this.events.shift();
      for (const waiter of [...this.waiters]) if (waiter(frame.event)) this.waiters.delete(waiter);
    }
  }
  call(method, payload, commandId, timeoutMs = 30_000) {
    const id = "matrix-" + (++this.next);
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(coded("RPC_TIMEOUT")); }, timeoutMs);
      this.pending.set(id, (response) => { clearTimeout(timer); done(response); });
      try { this.ws.send(JSON.stringify({ type: "request", id, method, payload, ...(commandId ? { commandId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  waitEvent(predicate, timeoutMs) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(coded("EVENT_TIMEOUT")); }, timeoutMs);
      const waiter = (event) => { if (!predicate(event)) return false; clearTimeout(timer); done(event); return true; };
      this.waiters.add(waiter);
    });
  }
  waitTerminal(turnId, timeoutMs) { return this.waitEvent((event) => TERMINALS.has(event?.type) && event?.payload?.turnId === turnId, timeoutMs); }
  close() { this.ws.close(); }
}
export async function openClient(info) {
  const require = createRequire(join(ROOT, "apps/mvp-host/package.json"));
  const WebSocket = require("ws");
  const post = async (path, body, cookie) => {
    const response = await fetch(new URL(path, info.baseUrl), { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw coded("AUTH_EXCHANGE_FAILED"); return response;
  };
  const { credential } = await (await post("/api/pairing/exchange", { token: info.token })).json();
  const auth = await post("/api/auth/browser-session", { credential });
  const cookie = (auth.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).find((value) => value.startsWith("flyx_session="));
  if (!cookie) throw coded("AUTH_COOKIE_MISSING");
  const { ticket } = await (await post("/api/auth/websocket-ticket", {}, cookie)).json();
  const ws = new WebSocket(info.baseUrl.replace(/^http/, "ws") + "/api/ws?ticket=" + encodeURIComponent(ticket), { origin: info.baseUrl });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(coded("WS_CONNECT_TIMEOUT")), 15_000);
    ws.onopen = () => { clearTimeout(timer); done(); }; ws.onerror = () => { clearTimeout(timer); reject(coded("WS_CONNECT_FAILED")); };
  });
  const client = new RpcClient(ws);
  const subscribed = await client.call("session.subscribe", { afterSequence: 0 });
  if (!subscribed.ok) { client.close(); throw coded("SUBSCRIBE_FAILED"); }
  return client;
}
async function runTurn(client, { layer, index, prompt, scenario = "turn", commandId }) {
  const start = Date.now();
  const record = { layer, scenario, index, promptHash: hash(prompt), startedAt: new Date(start).toISOString(), turnIdHash: null, terminalType: null, result: "failed", errorCode: null };
  let turnId;
  try {
    const response = await client.call("session.startTurn", { prompt }, commandId ?? randomUUID());
    if (!response.ok || typeof response.payload?.turnId !== "string") throw coded(response.error?.code ?? "TURN_ADMISSION_FAILED");
    turnId = response.payload.turnId; record.turnIdHash = hash(turnId);
    if (scenario === "approval") {
      const request = await client.waitEvent((event) => event?.type === "approval.requested" && event?.payload?.turnId === turnId, 60_000);
      const answer = await client.call("approval.respond", { approvalId: request.payload.approvalId, expectedVersion: request.payload.version ?? 0, action: "deny" }, randomUUID());
      if (!answer.ok) throw coded("APPROVAL_RESPONSE_FAILED");
    } else if (scenario === "interrupt") {
      await client.waitEvent((event) => event?.type === "turn.started" && event?.payload?.turnId === turnId, 60_000);
      const interrupt = await client.call("session.interrupt", {}, randomUUID());
      if (!interrupt.ok) throw coded("INTERRUPT_REQUEST_FAILED");
    }
    const terminal = await client.waitTerminal(turnId, layer === "real" ? 300_000 : 30_000);
    record.terminalType = terminal.type;
    record.result = scenario === "interrupt" ? terminal.type === "turn.cancelled" ? "passed" : "failed" : terminal.type === "turn.completed" ? "passed" : "failed";
  } catch (error) {
    record.errorCode = code(error);
    if (turnId) {
      try { await client.call("session.interrupt", {}, randomUUID(), 15_000); await client.waitTerminal(turnId, 15_000); } catch {}
    }
  }
  record.durationMs = Date.now() - start;
  return record;
}
async function runLayer(layer, combo, context) {
  let host;
  let layerResult;
  const records = [];
  try {
    host = await startHost({ layer, combo, ...context });
    const observed = { nodeVersion: process.versions.node, os: process.platform + " " + release() + " " + arch(), ...host.info.observed };
    if (layer === "real") {
      const match = environmentMatches(combo, observed);
      if (!match.matched) return layerResult = { outcome: { status: "skipped", completed: 0, reasonCode: "RUNTIME_COMBINATION_UNVERIFIED", reasons: match.reasonCodes }, observed, records, handshake: host.info };
    }
    const client = await openClient(host.info);
    try {
      for (let index = 1; index <= context.turns; index += 1) records.push(await runTurn(client, { layer, index, prompt: context.prompt, ...(layer === "real" ? { commandId: compatibilitySceneCommandIds(context.runId)[index - 1] } : {}) }));
      if (layer === "real") for (const scenario of ["approval", "interrupt"]) {
        const spec = context.scenarios?.[scenario];
        if (spec?.prompt) for (let index = 1; index <= (spec.repetitions ?? 1); index += 1) records.push(await runTurn(client, { layer, index, prompt: spec.prompt, scenario }));
      }
    } finally { client.close(); }
    const turns = records.filter((record) => record.scenario === "turn");
    return layerResult = { records, observed, handshake: host.info, outcome: { status: records.some((record) => record.result !== "passed") ? "failed" : "passed", completed: turns.filter((record) => record.result === "passed").length, scenarioResults: Object.fromEntries(["approval", "interrupt", "recovery"].map((kind) => [kind, { status: records.some((record) => record.scenario === kind) ? records.filter((record) => record.scenario === kind).every((record) => record.result === "passed") ? "passed" : "failed" : "skipped", reasonCode: records.some((record) => record.scenario === kind) ? null : "SCENARIO_NOT_CONFIGURED" }])) } };
  } catch (error) { return layerResult = { records, observed: host?.info.observed ?? {}, outcome: { status: "blocked", completed: 0, reasonCode: code(error) } }; }
  finally {
    if (host) {
      const stopped = await stopHost(host.child);
      if (layerResult) {
        layerResult.outcome.shutdown = stopped.status;
        if (stopped.status === "forced" || stopped.code !== 0) {
          layerResult.outcome.status = "blocked";
          layerResult.outcome.reasonCode = "HOST_STOP_UNVERIFIED";
        }
      }
    }
  }
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, { config: join(ROOT, "config/claude-compatibility.json"), evidenceRoot: join(ROOT, ".flyx-evidence") });
  if (options.help) { process.stdout.write(USAGE); return 0; }
  const config = JSON.parse(await readFile(resolve(options.config), "utf8"));
  const combos = config.lockedCombinations ?? [];
  if (!Array.isArray(combos) || combos.some((combo) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(combo.id) || !["claude", "codex"].includes(combo.provider ?? "claude"))) throw coded("MATRIX_CONFIG_INVALID");
  const selected = options.combo ? combos.filter((combo) => combo.id === options.combo) : combos.filter((combo) => ["pending", "deterministic-verified"].includes(combo.status));
  const runId = options.runId ?? randomUUID();
  const evidenceRoot = resolve(options.evidenceRoot);
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  if (selected.length === 0) {
    await writeJson(join(evidenceRoot, "run-" + runId + ".json"), { v: 1, runId, status: "skipped", reasonCode: "NO_SELECTED_COMBINATIONS" });
    log("skipped: NO_SELECTED_COMBINATIONS"); return options.combo ? 2 : 0;
  }
  if (config.sceneVersion !== SCENE_VERSION || config.matrixPrompt?.text !== BASIC_PROMPT) throw coded("MATRIX_FIXED_SCENE_REQUIRED");
  if (config.realScenarios && Object.keys(config.realScenarios).length) throw coded("MATRIX_SCENE_UNSUPPORTED");
  const turns = options.turns ?? config.deterministicRequirements?.turns ?? 10;
  if (options.real && turns !== 10) throw coded("MATRIX_REAL_SCENE_REQUIRES_TEN_TURNS");
  if (!Number.isInteger(turns) || turns < 1 || turns > 100) throw coded("MATRIX_CONFIG_INVALID");
  for (const kind of ["approval", "interrupt"]) {
    const spec = config.realScenarios?.[kind];
    if (spec && (typeof spec.prompt !== "string" || !spec.prompt || Buffer.byteLength(spec.prompt) > 65_536 || !Number.isInteger(spec.repetitions ?? 1) || (spec.repetitions ?? 1) < 1 || (spec.repetitions ?? 1) > 100)) throw coded("MATRIX_CONFIG_INVALID");
  }
  let exitCode = 0;
  for (const original of selected) {
    const combo = { ...original, authorizationPath: options.authorization ? resolve(options.authorization) : undefined, destinationHostPath: options.destinationHost ? resolve(options.destinationHost) : undefined, provider: original.provider ?? "claude" };
    const directory = join(evidenceRoot, combo.id, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const scratch = join(directory, "scratch");
    const nativePath = join(directory, "native.jsonl");
    if (options.prepare) {
      const controlled = join(scratch, "real"); await mkdir(controlled, { recursive: true, mode: 0o700 }); await chmod(controlled, 0o700);
      const { loadOrCreateHostIdentity, publicHostIdentity } = await import(pathToFileURL(join(ROOT, "apps/mvp-host/dist/identity/host-identity.js")).href);
      const identity = await loadOrCreateHostIdentity({ directory: join(controlled, "identity") });
      const sourceHost = publicHostIdentity(identity);
      const entryPath = await realpath(join(ROOT, "apps/mvp-host/dist/main.js"));
      const entryDigest = hash(await readFile(entryPath));
      await writeJson(join(directory, "source-host.json"), sourceHost);
      await writeJson(join(directory, "preparation.json"), { v: 1, runId, comboId: combo.id, provider: combo.provider, sourceHost, entryPath, entryDigest,
        sourceHostPath: join(directory, "source-host.json"), commandIds: compatibilitySceneCommandIds(runId), note: "Authorize this source before --real --run-id; measure exact runtime/artifact digests for destination authorization. No model was called." });
      log(combo.id + ": prepared run=" + runId); continue;
    }
    const context = { scratch, nativePath, runId, turns, prompt: config.matrixPrompt.text, scenarios: config.realScenarios };
    let deterministic, real;
    try {
      deterministic = await runLayer("deterministic", combo, context);
      const allowed = options.real && !options.deterministicOnly && process.env[combo.provider === "claude" ? "RUN_REAL_CLAUDE" : "RUN_REAL_CODEX"] === "1";
      real = !allowed ? { records: [], observed: {}, outcome: { status: "skipped", completed: 0, reasonCode: "REAL_EXECUTION_NOT_ENABLED" } }
        : deterministic.outcome.status !== "passed" ? { records: [], observed: {}, outcome: { status: "skipped", completed: 0, reasonCode: "DETERMINISTIC_LAYER_NOT_PASSED" } }
          : await runLayer("real", combo, context);
      if (real.handshake) {
        const { token: _credential, ...signedReadiness } = real.handshake;
        await writeJson(join(directory, "readiness.json"), signedReadiness);
      }
      const records = [...deterministic.records, ...real.records];
      if (records.length) await writeFile(join(directory, "turns.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
      let native = { records: [], invalid: 0 };
      try { native = parseNativeEvidence(await readPrivateArtifact(nativePath, 8 * 1024 * 1024), { runId, provider: combo.provider, host: real.handshake?.host, entryDigest: real.handshake?.entryDigest, sceneVersion: real.handshake?.sceneVersion, artifact: real.observed }); }
      catch (error) { if (error?.code !== "ENOENT") native = { records: [], invalid: 1 }; }
      const evaluation = evaluateVerification({ combo, deterministic: deterministic.outcome, real: real.outcome, native, observed: real.observed, requirements: { deterministic: config.deterministicRequirements, real: config.realRequirements } });
      const summary = { v: 2, runId, comboId: combo.id, provider: combo.provider, ranAt: new Date().toISOString(), expected: { nodeVersion: combo.nodeVersion, os: combo.os, sdkVersion: combo.sdkVersion, cliVersion: combo.claudeCliVersion ?? combo.codexCliVersion, executableSource: combo.executableSource, capabilities: combo.capabilities ?? [] }, observed: real.observed, deterministicObserved: deterministic.observed, layers: { deterministic: deterministic.outcome, real: real.outcome }, nativeEvidence: { counts: evaluation.counts, invalid: evaluation.invalidEvidence, complete: evaluation.nativeComplete, capabilities: evaluation.capabilities }, result: evaluation.currentVerification, persistedStatus: evaluation.status, environment: evaluation.environment };
      await writeJson(join(directory, "summary.json"), summary);
      original.status = evaluation.status;
      original.lastRun = { runId, at: summary.ranAt, deterministic: deterministic.outcome, real: real.outcome, result: evaluation.currentVerification, nativeEvidence: summary.nativeEvidence };
      original.evidence = { readiness: join(directory, "readiness.json"), summary: join(directory, "summary.json"), turns: join(directory, "turns.jsonl"), native: nativePath };
      await writeJson(resolve(options.config), config);
      log(combo.id + ": det=" + deterministic.outcome.status + " real=" + real.outcome.status + " current=" + evaluation.currentVerification);
      if (evaluation.currentVerification === "broken") exitCode = 1;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  return exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((value) => { process.exitCode = value; }, (error) => { log("blocked: " + code(error)); process.exitCode = 2; });
}

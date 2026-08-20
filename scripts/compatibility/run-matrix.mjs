#!/usr/bin/env node
/**
 * Claude SDK/CLI 兼容矩阵执行器（设计文档 5.6 节）。
 *
 * 读取 config/claude-compatibility.json，对 status=pending 的锁定组合执行两层验证：
 *
 *   1. deterministic 层：spawn apps/mvp-host/src/test-support/e2e-main.ts
 *      （与 Playwright E2E 相同的真实 server 栈 + DeterministicAdapter），通过
 *      Host HTTP/WSS API 发 N 个 Turn，验证 Flyx 编排/状态机。
 *   2. real 层：spawn apps/mvp-host/src/main.ts（真实 ClaudeAdapter，真正调用
 *      Claude SDK/CLI——这正是"真实矩阵"的意义），同样通过 HTTP/WSS API 发
 *      N 个 Turn。
 *
 * 每次一个 Turn：发送矩阵固定安全 prompt（config.matrixPrompt.text）→ 等待
 * 权威终态事件（turn.completed / turn.failed / turn.cancelled）→ 把脱敏记录
 * （turnId、prompt 哈希、终态、耗时、错误摘要）追加到
 * .flyx-evidence/<combo>/turns.jsonl。绝不写入 prompt 原文、token、明文成本。
 *
 * 降级规则（不能装作验证过）：
 *   - claude CLI 不存在或版本不匹配 → real 层记 skipped（含原因），退出码 0；
 *   - Host 无法启动（依赖缺失、preflight 失败等环境问题）→ 该层记 blocked，
 *     组合状态保持不变；
 *   - 只有 Turn 真正执行且出现非 completed 终态/超时，才把组合标记 broken。
 *
 * 用法：
 *   node scripts/compatibility/run-matrix.mjs [--deterministic-only]
 *        [--combo <id>] [--turns <n>] [--config <path>] [--evidence-root <path>]
 */

import { spawn, execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, "config/claude-compatibility.json");
const DEFAULT_EVIDENCE_ROOT = resolve(REPO_ROOT, ".flyx-evidence");
const FIXTURE_WORKSPACE = resolve(REPO_ROOT, "packages/claude-fixtures");
const HOST_PACKAGE_FILTER = "@flyx/mvp-host";

const STATUS_RANK = { pending: 0, "deterministic-verified": 1, "fully-verified": 2 };
const TERMINAL_EVENT_TYPES = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
const TURN_TIMEOUT_MS = { deterministic: 30_000, real: 300_000 };
const HOST_READY_TIMEOUT_MS = { deterministic: 60_000, real: 180_000 };

const log = (message) => console.log(`[matrix] ${message}`);
const fail = (message) => console.error(`[matrix] ERROR: ${message}`);

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function extractSemver(text) {
  return /\b\d+\.\d+\.\d+\b/.exec(text ?? "")?.[0] ?? null;
}

/** 错误摘要只保留结构化 code / 已知标签，绝不携带原始 message（可能含路径/密钥）。 */
function summarizeError(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  if (error instanceof Error) {
    if (/^ready timeout/i.test(error.message)) return "HOST_READY_TIMEOUT";
    if (/timeout/i.test(error.message)) return "TURN_TIMEOUT";
    return "ERROR";
  }
  return "ERROR";
}

function redactLine(line) {
  return line
    .replace(/token=[^\s,]+/g, "token=[redacted]")
    .replace(/Pairing token: \S+/g, "Pairing token: [redacted]");
}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { deterministicOnly: false, combo: undefined, turns: undefined, config: DEFAULT_CONFIG_PATH, evidenceRoot: DEFAULT_EVIDENCE_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--deterministic-only":
        options.deterministicOnly = true;
        break;
      case "--combo":
        options.combo = argv[++index];
        if (!options.combo) { fail("--combo 需要一个组合 id 参数"); process.exit(2); }
        break;
      case "--turns": {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value < 1 || value > 100) { fail("--turns 需要一个 1-100 的整数"); process.exit(2); }
        options.turns = value;
        break;
      }
      case "--config":
        options.config = argv[++index];
        if (!options.config) { fail("--config 需要一个路径参数"); process.exit(2); }
        break;
      case "--evidence-root":
        options.evidenceRoot = argv[++index];
        if (!options.evidenceRoot) { fail("--evidence-root 需要一个路径参数"); process.exit(2); }
        break;
      default:
        fail(`未知参数 ${arg}（用 --help 查看用法）`);
        process.exit(2);
    }
  }
  return options;
}

const USAGE = `用法: node scripts/compatibility/run-matrix.mjs [选项]

选项:
  --deterministic-only   只跑 deterministic 层（DeterministicAdapter），不跑真实 Claude Turn
  --combo <id>           只跑指定组合（默认跑所有 status=pending 的组合）
  --turns <n>            每层的 Turn 次数（默认取 config 的 deterministicRequirements.turns，即 10）
  --config <path>        矩阵配置文件路径（默认 config/claude-compatibility.json）
  --evidence-root <path> 证据输出根目录（默认 .flyx-evidence/）

前置条件（真实层）: pnpm install 已执行、本机 claude CLI 版本与组合锁定版本一致且已登录。
`;

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

async function readJson(path) {
  const text = await readFile(path, "utf8");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error(`${path} 不是 JSON 对象`);
  return value;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rankStatus(status) {
  return STATUS_RANK[status] ?? -1;
}

// ---------------------------------------------------------------------------
// 本机环境探测
// ---------------------------------------------------------------------------

async function detectClaudeCli() {
  try {
    const { stdout, stderr } = await execFile("claude", ["--version"], { timeout: 15_000 });
    const raw = `${stdout} ${stderr}`.trim();
    return { available: true, version: extractSemver(raw), raw };
  } catch (error) {
    const code = error?.code;
    const reason = code === "ENOENT"
      ? "claude CLI 不在 PATH 上（未安装或未暴露给当前 shell）"
      : `claude --version 执行失败（${typeof code === "string" ? code : "unknown"}）`;
    return { available: false, version: null, raw: null, reason };
  }
}

async function detectPnpm() {
  try {
    await execFile("pnpm", ["--version"], { timeout: 30_000 });
    return { command: "pnpm", prefix: [] };
  } catch {
    try {
      await execFile("corepack", ["pnpm", "--version"], { timeout: 30_000 });
      return { command: "corepack", prefix: ["pnpm"] };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Host 进程管理
// ---------------------------------------------------------------------------

/**
 * spawn 一个 Host 子进程并等待其 stdout 就绪行。
 * spec.ready(rawLine) 命中时返回 info 对象，进程即认为就绪。
 * 失败时 reject，并附带脱敏后的 stdout/stderr 尾部用于诊断。
 */
function startHost(spec) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, [...spec.prefix, ...spec.args], {
      cwd: spec.cwd ?? REPO_ROOT,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = [];
    const push = (line) => {
      if (line.trim().length === 0) return;
      tail.push(redactLine(line));
      if (tail.length > 200) tail.shift();
    };
    let settled = false;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.removeAllListeners("exit");
        child.kill("SIGKILL");
        rejectPromise(Object.assign(error, { tail }));
      } else {
        resolvePromise({ child, info, tail });
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`${spec.label}: 等待就绪行超时（${spec.timeoutMs}ms）`));
    }, spec.timeoutMs);

    createInterface({ input: child.stdout }).on("line", (line) => {
      push(line);
      try {
        const info = spec.ready(line);
        if (info) finish(null, info);
      } catch (error) {
        finish(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { for (const line of String(chunk).split("\n")) push(line); });
    child.on("error", (error) => finish(new Error(`${spec.label}: 无法启动 ${spec.command}（${error.code ?? error.message}）`)));
    child.on("exit", (code, signal) => {
      finish(new Error(`${spec.label}: 就绪前退出（code=${code} signal=${signal}）\n  ${tail.slice(-6).join("\n  ")}`));
    });
  });
}

async function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timeout);
}

// ---------------------------------------------------------------------------
// Host API 客户端（HTTP 认证 + WSS RPC）
// ---------------------------------------------------------------------------

class RpcClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = new Set();
    ws.onmessage = (message) => {
      try { this.handleFrame(JSON.parse(typeof message.data === "string" ? message.data : "")); } catch { /* 忽略非 JSON 帧 */ }
    };
    ws.onclose = () => {
      for (const settle of this.pending.values()) settle({ type: "response", id: "?", ok: false, error: { code: "WS_CLOSED", message: "websocket closed", retryable: false } });
      this.pending.clear();
    };
  }

  handleFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "response") {
      const settle = this.pending.get(frame.id);
      if (settle) { this.pending.delete(frame.id); settle(frame); }
      return;
    }
    if (frame.type === "event") {
      for (const waiter of [...this.waiters]) {
        if (waiter(frame.event)) this.waiters.delete(waiter);
      }
    }
  }

  call(method, payload, commandId, timeoutMs = 30_000) {
    this.nextId += 1;
    const id = `matrix-${this.nextId}`;
    const frame = { type: "request", id, method, ...(commandId ? { commandId } : {}), payload };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error("request timeout"));
      }, timeoutMs);
      this.pending.set(id, (response) => { clearTimeout(timer); resolvePromise(response); });
      try { this.ws.send(JSON.stringify(frame)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); rejectPromise(error); }
    });
  }

  /** 等待指定 turn 的权威终态事件。 */
  waitTerminal(turnId, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectPromise(new Error("terminal timeout"));
      }, timeoutMs);
      const waiter = (event) => {
        if (TERMINAL_EVENT_TYPES.has(event?.type) && event?.payload?.turnId === turnId) {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolvePromise(event);
          return true;
        }
        return false;
      };
      this.waiters.add(waiter);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function openHostClient(base, pairingToken) {
  const post = async (path, body, cookie) => {
    const response = await fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response;
  };

  const credentialResponse = await post("/api/pairing/exchange", { token: pairingToken });
  const { credential } = await credentialResponse.json();
  const sessionResponse = await post("/api/auth/browser-session", { credential });
  const sessionCookie = (sessionResponse.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith("flyx_session="));
  if (!sessionCookie) throw new Error("browser session cookie 缺失");
  const ticketResponse = await post("/api/auth/websocket-ticket", {}, sessionCookie);
  const { ticket } = await ticketResponse.json();

  const wsUrl = `${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(wsUrl, { headers: { origin: base } });
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("websocket connect timeout")), 15_000);
    ws.onopen = () => { clearTimeout(timer); resolvePromise(); };
    ws.onerror = () => { clearTimeout(timer); rejectPromise(new Error("websocket connect failed")); };
  });
  const client = new RpcClient(ws);
  const subscribe = await client.call("session.subscribe", { afterSequence: 0 }, undefined, 15_000);
  if (!subscribe.ok) { client.close(); throw new Error(`session.subscribe 失败: ${subscribe.error?.code ?? "unknown"}`); }
  return client;
}

// ---------------------------------------------------------------------------
// Turn 执行
// ---------------------------------------------------------------------------

async function runTurns({ layer, turns, prompt, promptId, promptHash, client, timeoutMs, label }) {
  const records = [];
  for (let index = 1; index <= turns; index += 1) {
    const commandId = randomUUID();
    const startedAt = Date.now();
    const record = {
      layer,
      index,
      turnId: null,
      promptId,
      promptHash,
      commandIdHash: sha256(commandId).slice(0, 16),
      startedAt: new Date(startedAt).toISOString(),
      terminalType: null,
      turnStatus: null,
      durationMs: null,
      errorSummary: null,
    };
    try {
      const response = await client.call("session.startTurn", { prompt }, commandId, 30_000);
      if (!response.ok) throw Object.assign(new Error("rpc"), { code: response.error?.code ?? "RPC_ERROR" });
      record.turnId = response.payload?.turnId ?? null;
      const terminal = await client.waitTerminal(record.turnId, timeoutMs);
      record.terminalType = terminal.type;
      record.turnStatus = terminal.type?.split(".")[1] ?? null;
    } catch (error) {
      record.errorSummary = summarizeError(error);
      record.turnStatus = record.turnStatus ?? "error";
      // 尽量把 session 拉回 idle，避免一个卡死的 Turn 拖垮后续样本；
      // 恢复失败不影响本条证据（已如实记录）。
      if (record.turnId) {
        try {
          await client.call("session.interrupt", {}, randomUUID(), 15_000);
          await client.waitTerminal(record.turnId, 15_000).catch(() => undefined);
        } catch { /* 尽力而为 */ }
      }
    }
    record.durationMs = Date.now() - startedAt;
    record.finishedAt = new Date().toISOString();
    records.push(record);
    log(`${label} turn ${index}/${turns}: ${record.turnStatus ?? "?"}${record.errorSummary ? ` (${record.errorSummary})` : ""} in ${record.durationMs}ms`);
  }
  return records;
}

// ---------------------------------------------------------------------------
// 组合验证
// ---------------------------------------------------------------------------

function layerOutcome(records) {
  if (records.length === 0) return { status: "blocked", reason: "没有执行任何 Turn" };
  const failed = records.filter((record) => record.turnStatus !== "completed");
  return failed.length === 0
    ? { status: "passed", completed: records.length, failed: 0 }
    : { status: "failed", completed: records.length - failed.length, failed: failed.length, failures: failed.map((record) => record.errorSummary ?? record.terminalType ?? record.turnStatus) };
}

async function runDeterministicLayer(combo, { pnpm, evidenceDir, turns, prompt, promptId, promptHash }) {
  const scratch = resolve(evidenceDir, "scratch");
  const webRoot = resolve(scratch, "webroot");
  await mkdir(webRoot, { recursive: true });
  const spec = {
    label: `deterministic host (${combo.id})`,
    command: pnpm.command,
    prefix: pnpm.prefix,
    args: ["--filter", HOST_PACKAGE_FILTER, "exec", "tsx", "src/test-support/e2e-main.ts"],
    env: {
      FLYX_WORKSPACE: FIXTURE_WORKSPACE,
      FLYX_WEB_ROOT: webRoot,
      FLYX_E2E_ROOT: resolve(scratch, "det-e2e"),
    },
    timeoutMs: HOST_READY_TIMEOUT_MS.deterministic,
    ready: (line) => {
      const match = /^FLYX_E2E_HOST_READY base=(\S+) token=(\S+)/.exec(line);
      return match ? { base: match[1], token: match[2] } : null;
    },
  };
  log(`启动 deterministic Host（DeterministicAdapter，复用 Playwright E2E 入口）`);
  const host = await startHost(spec);
  try {
    const client = await openHostClient(host.info.base, host.info.token);
    try {
      return await runTurns({
        layer: "deterministic",
        turns,
        prompt,
        promptId,
        promptHash,
        client,
        timeoutMs: TURN_TIMEOUT_MS.deterministic,
        label: `[${combo.id}] det`,
      });
    } finally {
      client.close();
    }
  } finally {
    await stopHost(host.child);
    await rm(resolve(scratch, "det-e2e"), { recursive: true, force: true });
  }
}

async function runRealLayer(combo, { pnpm, evidenceDir, turns, prompt, promptId, promptHash }) {
  const scratch = resolve(evidenceDir, "scratch", "real");
  await mkdir(scratch, { recursive: true });
  const readyCapture = { listening: undefined, token: undefined, preflight: undefined };
  const spec = {
    label: `real host (${combo.id})`,
    command: pnpm.command,
    prefix: pnpm.prefix,
    args: ["--filter", HOST_PACKAGE_FILTER, "exec", "tsx", "src/main.ts"],
    env: {
      PORT: "0",
      FLYX_WORKSPACE: FIXTURE_WORKSPACE,
      FLYX_DB: resolve(scratch, "host.sqlite"),
      // 矩阵脚本没有 TTY 也没有人工确认配对的场景，仅 loopback 本机测试。
      FLYX_ALLOW_INSECURE_HTTP: "1",
      FLYX_REQUIRE_PAIRING_CONFIRM: "0",
    },
    timeoutMs: HOST_READY_TIMEOUT_MS.real,
    ready: (line) => {
      const readyState = readyCapture;
      const listening = /^Flyx MVP Host listening at (\S+)/.exec(line);
      const token = /^Pairing token: (\S+)/.exec(line);
      const preflight = /^Claude preflight passed: SDK (\S+), CLI (\S+)/.exec(line);
      readyState.listening = listening?.[1] ?? readyState.listening;
      readyState.token = token?.[1] ?? readyState.token;
      if (preflight) readyState.preflight = { sdkVersion: preflight[1], claudeVersion: preflight[2] };
      return readyState.listening && readyState.token ? { ...readyState } : null;
    },
  };
  log(`启动 real Host（真实 ClaudeAdapter + Claude SDK/CLI，preflight 将真实执行）`);
  const host = await startHost(spec);
  try {
    const client = await openHostClient(host.info.listening, host.info.token);
    try {
      return await runTurns({
        layer: "real",
        turns,
        prompt,
        promptId,
        promptHash,
        client,
        timeoutMs: TURN_TIMEOUT_MS.real,
        label: `[${combo.id}] real`,
      });
    } finally {
      client.close();
    }
  } finally {
    await stopHost(host.child);
  }
}

async function countJsonlLines(path) {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let valid = 0;
    for (const line of lines) {
      try { JSON.parse(line); valid += 1; } catch { /* 跳过残缺行 */ }
    }
    return valid;
  } catch {
    return 0;
  }
}

async function appendEvidence(path, records) {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readJson(options.config);
  const combos = Array.isArray(config.lockedCombinations) ? config.lockedCombinations : [];
  if (combos.length === 0) { log("配置中没有任何 lockedCombinations"); return 0; }

  const selected = options.combo
    ? combos.filter((combo) => combo.id === options.combo)
    : combos.filter((combo) => combo.status === "pending");
  if (options.combo && selected.length === 0) { fail(`--combo ${options.combo} 不存在于 ${options.config}`); return 2; }
  if (selected.length === 0) { log("没有 status=pending 的组合，矩阵已是最新（用 --combo <id> 可重跑指定组合）"); return 0; }

  const turns = options.turns ?? config.deterministicRequirements?.turns ?? 10;
  const promptText = config.matrixPrompt?.text;
  if (!promptText) { fail("配置缺少 matrixPrompt.text"); return 2; }
  const promptId = config.matrixPrompt.id ?? "matrix-prompt";
  const promptHash = sha256(promptText);

  const claude = await detectClaudeCli();
  const pnpm = await detectPnpm();
  if (claude.available) log(`本机 claude CLI: ${claude.raw}（解析版本 ${claude.version ?? "unknown"}）`);
  else log(`本机 claude CLI 不可用：${claude.reason} → real 层将记 skipped`);
  if (!pnpm) { fail("找不到 pnpm 或 corepack，无法启动 Host；矩阵保持 pending 未验证"); return 0; }

  let exitCode = 0;
  for (const combo of selected) {
    log(`=== 组合 ${combo.id}（当前状态 ${combo.status}）===`);
    const evidenceDir = resolve(REPO_ROOT, options.evidenceRoot, combo.id);
    await mkdir(evidenceDir, { recursive: true });
    const context = { pnpm, evidenceDir, turns, prompt: promptText, promptId, promptHash };

    // --- deterministic 层 ---
    let deterministic = { status: "blocked", reason: "未执行" };
    let deterministicRecords = [];
    try {
      deterministicRecords = await runDeterministicLayer(combo, context);
      deterministic = layerOutcome(deterministicRecords);
    } catch (error) {
      deterministic = { status: "blocked", reason: summarizeError(error) === "ERROR" ? (error instanceof Error ? redactLine(error.message).slice(0, 300) : "unknown") : summarizeError(error) };
      log(`deterministic 层未执行（blocked）: ${deterministic.reason}`);
    }
    await appendEvidence(resolve(evidenceDir, "turns.jsonl"), deterministicRecords);

    // --- real 层 ---
    let real = { status: "skipped", reason: "未执行" };
    let realRecords = [];
    if (options.deterministicOnly) {
      real = { status: "skipped", reason: "--deterministic-only" };
      log("real 层跳过（--deterministic-only）");
    } else if (!claude.available) {
      real = { status: "skipped", reason: claude.reason };
      log(`real 层跳过（skipped）: ${real.reason}`);
    } else if (claude.version !== combo.claudeCliVersion) {
      real = { status: "skipped", reason: `本机 claude CLI ${claude.version ?? "unknown"} 与锁定版本 ${combo.claudeCliVersion} 不一致` };
      log(`real 层跳过（skipped）: ${real.reason}`);
    } else if (deterministic.status !== "passed") {
      real = { status: "skipped", reason: `deterministic 层未通过（${deterministic.status}），按矩阵规则不进入真实 Turn` };
      log(`real 层跳过: ${real.reason}`);
    } else {
      try {
        realRecords = await runRealLayer(combo, context);
        real = layerOutcome(realRecords);
      } catch (error) {
        real = { status: "blocked", reason: error instanceof Error ? redactLine(error.message).slice(0, 300) : "unknown" };
        log(`real 层被环境阻塞（blocked）: ${real.reason}`);
      }
      await appendEvidence(resolve(evidenceDir, "turns.jsonl"), realRecords);
    }

    // --- 汇总与状态更新 ---
    await rm(resolve(evidenceDir, "scratch"), { recursive: true, force: true });
    const approvals = real.status === "passed" ? await countJsonlLines(resolve(evidenceDir, "approvals.jsonl")) : 0;
    const interrupts = real.status === "passed" ? await countJsonlLines(resolve(evidenceDir, "interrupts.jsonl")) : 0;
    const required = config.realRequirements ?? { turns: 10, approvals: 10, interrupts: 10 };

    // 只有满足要求的 Turn 次数（默认 10）的运行才有资格提升等级；broken 无论样本数都生效。
    const qualifies = turns >= (config.deterministicRequirements?.turns ?? 10);
    let newStatus = combo.status;
    if (deterministic.status === "failed" || real.status === "failed") newStatus = "broken";
    else if (!qualifies) newStatus = combo.status;
    else if (deterministic.status === "passed" && real.status === "passed"
      && approvals >= (required.approvals ?? 10) && interrupts >= (required.interrupts ?? 10)) newStatus = "fully-verified";
    else if (deterministic.status === "passed") newStatus = rankStatus("deterministic-verified") > rankStatus(combo.status) ? "deterministic-verified" : combo.status;
    // blocked / skipped：状态保持不变，绝不装作验证过。

    const noteBits = [`det=${deterministic.status}`, `real=${real.status}`];
    if (!qualifies) noteBits.push(`冒烟运行（${turns} < 要求 ${config.deterministicRequirements?.turns ?? 10} turns，不提升等级）`);
    if (deterministic.status === "passed") noteBits.push(`det turns ${deterministic.completed}/${turns}`);
    if (real.status === "passed") noteBits.push(`real turns ${real.completed}/${turns}`);
    if (real.status === "passed" && (approvals < (required.approvals ?? 10) || interrupts < (required.interrupts ?? 10))) {
      noteBits.push(`等待 approvals(${approvals}/${required.approvals ?? 10}) / interrupts(${interrupts}/${required.interrupts ?? 10}) 证据后才能 fully-verified`);
    }
    const note = `${new Date().toISOString()} run(${turns} turns/层): ${noteBits.join(", ")}${deterministic.reason ? `; det reason: ${deterministic.reason}` : ""}${real.reason ? `; real reason: ${real.reason}` : ""} → ${newStatus}`;

    combo.status = newStatus;
    combo.observed = {
      nodeVersion: process.versions.node,
      claudeCliVersion: claude.version,
      ...(claude.available ? { claudeCliRaw: claude.raw } : {}),
    };
    combo.lastRun = {
      at: new Date().toISOString(),
      turnsPerLayer: turns,
      deterministic,
      real,
      approvalsEvidence: approvals,
      interruptsEvidence: interrupts,
      promptId,
      promptHash,
    };
    if (!Array.isArray(combo.notes)) combo.notes = [];
    combo.notes.push(note);
    if (combo.notes.length > 10) combo.notes = combo.notes.slice(-10);
    combo.evidence = {
      turns: `${relativeEvidence(options.evidenceRoot)}/${combo.id}/turns.jsonl`,
      approvals: `${relativeEvidence(options.evidenceRoot)}/${combo.id}/approvals.jsonl`,
      interrupts: `${relativeEvidence(options.evidenceRoot)}/${combo.id}/interrupts.jsonl`,
      summary: `${relativeEvidence(options.evidenceRoot)}/${combo.id}/summary.json`,
    };

    await writeJson(resolve(evidenceDir, "summary.json"), {
      comboId: combo.id,
      ranAt: combo.lastRun.at,
      expected: { sdkVersion: combo.sdkVersion, claudeCliVersion: combo.claudeCliVersion, nodeVersion: combo.nodeVersion },
      observed: combo.observed,
      layers: { deterministic, real },
      turnsPerLayer: turns,
      approvalsEvidence: approvals,
      interruptsEvidence: interrupts,
      result: newStatus,
    });
    await writeJson(options.config, config);
    log(`组合 ${combo.id} → ${newStatus}（证据已写入 ${relativeEvidence(options.evidenceRoot)}/${combo.id}/）`);

    if (deterministic.status === "failed" || real.status === "failed") exitCode = 1;
  }
  return exitCode;
}

function relativeEvidence(evidenceRoot) {
  const absolute = resolve(REPO_ROOT, evidenceRoot);
  return absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length + 1) : absolute;
}

const running = main();
const shutdown = () => { fail("被中断，矩阵未完成，状态不会被标记为已验证"); process.exit(130); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
running.then((code) => process.exit(code ?? 0), (error) => {
  fail(error instanceof Error ? redactLine(error.message) : String(error));
  process.exit(2);
});

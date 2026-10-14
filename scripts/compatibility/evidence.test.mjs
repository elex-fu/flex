import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseNativeEvidence, parseReadiness, readReadiness, evaluateVerification, nativeCounts } from "./evidence.mjs";
import { openClient, RpcClient } from "./run-matrix.mjs";

const h = (character) => character.repeat(64);
const combo = { provider: "claude", status: "pending", nodeVersion: "24.18.0", os: "macOS 25.5.0 arm64", sdkVersion: "0.3.220", claudeCliVersion: "2.1.220", capabilities: ["interrupt"] };
const observed = { nodeVersion: "24.18.0", os: "darwin 25.5.0 arm64", sdkVersion: "0.3.220", cliVersion: "2.1.220", executablePath: "/resolved/claude", authMode: "signed_in", capabilities: ["interrupt"] };
const requirements = { deterministic: { turns: 1 }, real: { turns: 1, approvals: 1, interrupts: 1, recoveries: 1 } };
const passed = { status: "passed", completed: 1 };
function record(kind, overrides = {}) {
  return { v: 1, runId: "run-1", source: "native", provider: "claude", kind, result: "passed", nativeEvent: "result", evidenceCode: "NATIVE_VERIFIED", attemptIdHash: h("a"), nativeSessionIdHash: h("b"), ...(kind === "approval" ? { nativeRequestIdHash: h("c") } : {}), at: "2026-10-01T00:00:00.000Z", ...overrides };
}
test("argument parser rejects traversal, missing values and contradictory execution gates", () => {
  assert.deepEqual(parseArgs(["--deterministic-only", "--turns", "10", "--combo", "valid-id"]), { deterministicOnly: true, real: false, turns: 10, combo: "valid-id" });
  for (const args of [["--combo", "../identity"], ["--turns", "0"], ["--turns", "2.5"], ["--config", "--real"], ["--real", "--deterministic-only"], ["--unknown"]]) assert.throws(() => parseArgs(args));
});
test("readiness parsing allows only controlled loopback metadata and private relative credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "flyx-matrix-readiness-"));
  try {
    const input = { v: 1, pid: 1234, provider: "claude", baseUrl: "http://127.0.0.1:4173", credentialFile: "pairing-" + "a".repeat(32) + ".secret", observed, createdAt: "2026-10-01T00:00:00.000Z" };
    assert.equal(parseReadiness(JSON.stringify(input), { expectedPid: 1234 }).provider, "claude");
    assert.throws(() => parseReadiness(JSON.stringify({ ...input, credentialFile: "../identity/host-identity.json" })), /READINESS_INVALID/);
    assert.throws(() => parseReadiness(JSON.stringify({ ...input, baseUrl: "https://remote.example" })), /READINESS_LOOPBACK_REQUIRED/);
    assert.throws(() => parseReadiness(JSON.stringify(input), { expectedPid: 99 }), /READINESS_INVALID/);
    const path = join(root, "ready.json");
    await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    const credentialPath = join(root, input.credentialFile);
    await writeFile(credentialPath, "s".repeat(43) + "\n", { mode: 0o600 });
    assert.equal((await readReadiness(path, { expectedPid: 1234 })).token, "s".repeat(43));
    await chmod(credentialPath, 0o644);
    await assert.rejects(readReadiness(path), /READINESS_PERMISSIONS/);
    await chmod(credentialPath, 0o600);
    await chmod(root, 0o755);
    await assert.rejects(readReadiness(path), /READINESS_PERMISSIONS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("fixture/local terminal events and stale native runs cannot qualify as real evidence", () => {
  const text = [record("turn", { source: "flyx-terminal" }), record("turn", { runId: "old-run" }), record("approval", { nativeRequestIdHash: undefined }), "{broken"].map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  const native = parseNativeEvidence(text, { runId: "run-1", provider: "claude" });
  assert.equal(native.records.length, 0);
  assert.equal(native.invalid, 4);
  const result = evaluateVerification({ combo, deterministic: passed, real: passed, observed, native, requirements });
  assert.equal(result.currentVerification, "deterministic-verified");
  assert.equal(result.nativeComplete, false);
});
test("full promotion requires current native turn approval interrupt recovery plus matching runtime", () => {
  const native = parseNativeEvidence(["turn", "approval", "interrupt", "recovery"].map((kind) => JSON.stringify(record(kind))).join("\n"), { runId: "run-1", provider: "claude" });
  const input = { combo, deterministic: passed, real: passed, observed, native, requirements };
  assert.equal(evaluateVerification(input).currentVerification, "fully-verified");
  for (const missing of ["approval", "interrupt", "recovery"]) assert.equal(evaluateVerification({ ...input, native: { records: native.records.filter((record) => record.kind !== missing), invalid: 0 } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, observed: { ...observed, nodeVersion: "22.0.0" } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, observed: { ...observed, os: "linux 6.1 x64" } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, observed: { ...observed, authMode: "unknown" } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, combo: { provider: "claude", status: "pending" } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, observed: { ...observed, executablePath: "claude" } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, real: { status: "skipped", completed: 0 } }).currentVerification, "deterministic-verified");
  assert.equal(evaluateVerification({ ...input, real: { status: "failed", completed: 0 } }).currentVerification, "broken");
});
test("skips, unsupported cases and duplicate event lines never increase proof counts", () => {
  const turn = record("turn");
  assert.equal(nativeCounts([turn, turn, { ...turn, result: "skipped" }, { ...turn, result: "unsupported" }]).turn, 1);
  const native = { records: ["turn", "approval", "interrupt", "recovery"].map((kind) => record(kind, { result: "unsupported" })), invalid: 0 };
  const result = evaluateVerification({ combo, deterministic: { status: "blocked", completed: 0 }, real: { status: "skipped", completed: 0 }, native, observed: {}, requirements });
  assert.equal(result.currentVerification, "pending");
  assert.equal(result.status, "pending");
});
test("terminal events received before start RPC response are retained", async () => {
  const ws = { send() {}, close() {} };
  const client = new RpcClient(ws);
  client.handleFrame({ type: "event", event: { type: "turn.completed", payload: { turnId: "fast" } } });
  assert.equal((await client.waitTerminal("fast", 1)).type, "turn.completed");
});

test("matrix client sends the exact loopback Origin through real HTTP/WebSocket auth", { timeout: 5_000 }, async () => {
  const { createServer } = await import("node:http");
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../../apps/mvp-host/package.json", import.meta.url));
  const { WebSocketServer } = require("ws");
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/pairing/exchange") {
      assert.equal(body.token, "test-pairing-secret");
      response.end(JSON.stringify({ credential: "fixture-credential" }));
    } else if (request.url === "/api/auth/browser-session") {
      assert.equal(body.credential, "fixture-credential");
      response.setHeader("set-cookie", "flyx_session=fixture; HttpOnly");
      response.end("{}");
    } else if (request.url === "/api/auth/websocket-ticket") {
      assert.equal(request.headers.cookie, "flyx_session=fixture");
      response.end(JSON.stringify({ ticket: "fixture-ticket" }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  const sockets = new WebSocketServer({ noServer: true });
  let origin;
  server.on("upgrade", (request, socket, head) => {
    origin = request.headers.origin;
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });
  sockets.on("connection", (ws) => {
    ws.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString());
      ws.send(JSON.stringify({ type: "response", id: frame.id, ok: true, payload: {} }));
    });
  });
  let client;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    client = await openClient({ baseUrl, token: "test-pairing-secret" });
    assert.equal(origin, baseUrl);
    const response = await client.call("host.probe", {});
    assert.equal(response.ok, true);
  } finally {
    client?.close();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise((done) => sockets.close(done));
    server.closeIdleConnections();
    await new Promise((done) => server.close(done));
  }
});

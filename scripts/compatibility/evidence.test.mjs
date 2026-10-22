import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseNativeEvidence, parseReadiness, readReadiness, evaluateVerification, nativeCounts, digest, canonicalJson, verifySignedPayload, compatibilitySceneCommandIds } from "./evidence.mjs";
import { openClient, RpcClient } from "./run-matrix.mjs";

const h = (character) => character.repeat(64);
const combo = { provider: "claude", status: "pending", nodeVersion: "24.18.0", os: "macOS 25.5.0 arm64", sdkVersion: "0.3.220", claudeCliVersion: "2.1.220", capabilities: ["interrupt"] };
const observed = { providerVersion: "2.1.220", executableDigest: h("d"), configFingerprint: h("e"), adapterId: "claude-sdk", adapterVersion: "1", runtimeVersion: "1", runtimeDigest: h("f"), supervisionContractId: "verified-test-contract", nodeVersion: "24.18.0", os: "darwin 25.5.0 arm64", sdkVersion: "0.3.220", cliVersion: "2.1.220", executablePath: "/resolved/claude", authMode: "signed_in", capabilities: ["interrupt"] };
const requirements = { deterministic: { turns: 1 }, real: { turns: 1, approvals: 1, interrupts: 1, recoveries: 1 } };
const passed = { status: "passed", completed: 1 };
const signingKey = generateKeyPairSync("ed25519").privateKey;
const signingPublicKey = signingKey.export({ format: "jwk" }).x;
const hostPublicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x;
const host = { hostId: "11111111-1111-4111-8111-111111111111", hostPublicKey, signingPublicKey, fingerprint: "sha256:" + digest({ v: 1, hostPublicKey, signingPublicKey }) };
function signed(payload) {
  const unsigned = JSON.parse(JSON.stringify({ ...payload, host }));
  const value = digest(unsigned);
  return { ...unsigned, digest: value, signature: sign(null, Buffer.from("flyx-compatibility-v2\n" + value), signingKey).toString("base64url") };
}
const expected = { runId: "run-1", provider: "claude", host, domain: "fixture", entryDigest: h("a"), artifact: observed };
function record(kind, overrides = {}) {
  return signed({ v: 2, domain: "fixture", capability: kind, sceneVersion: "flyx-c3-basic-v1", entryDigest: h("a"), artifact: observed, launchRef: "launch-1", stopRef: "stop-1", nativeResultIdHash: h("d"), runId: "run-1", source: "native", provider: "claude", kind, result: "passed", nativeEvent: "result", evidenceCode: "NATIVE_VERIFIED", attemptIdHash: h("a"), nativeSessionIdHash: h("b"), ...(kind === "approval" ? { nativeRequestIdHash: h("c") } : {}), at: new Date().toISOString(), ...overrides });
}
test("argument parser rejects traversal, missing values and contradictory execution gates", () => {
  assert.deepEqual(parseArgs(["--deterministic-only", "--turns", "10", "--combo", "valid-id"]), { deterministicOnly: true, real: false, turns: 10, combo: "valid-id" });
  assert.equal(compatibilitySceneCommandIds("run-1").length, 10);
  assert.deepEqual(compatibilitySceneCommandIds("run-1"), compatibilitySceneCommandIds("run-1"));
  assert.notDeepEqual(compatibilitySceneCommandIds("run-1"), compatibilitySceneCommandIds("run-2"));
  assert.equal(parseArgs(["--prepare", "--run-id", "run-1"]).prepare, true);
  for (const args of [["--prepare", "--real"], ["--run-id", "../escape"], ["--combo", "../identity"], ["--turns", "0"], ["--turns", "2.5"], ["--config", "--real"], ["--real", "--deterministic-only"], ["--unknown"]]) assert.throws(() => parseArgs(args));
});
test("readiness parsing allows only controlled loopback metadata and private relative credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "flyx-matrix-readiness-"));
  try {
    const input = { v: 1, pid: 1234, provider: "deterministic", baseUrl: "http://127.0.0.1:4173", credentialFile: "pairing-" + "a".repeat(32) + ".secret", observed, createdAt: new Date().toISOString() };
    assert.equal(parseReadiness(JSON.stringify(input), { expectedPid: 1234, expectedProvider: "deterministic" }).provider, "deterministic");
    assert.throws(() => parseReadiness(JSON.stringify({ ...input, credentialFile: "../identity/host-identity.json" }), { expectedProvider: "deterministic" }), /READINESS_INVALID/);
    assert.throws(() => parseReadiness(JSON.stringify({ ...input, baseUrl: "https://remote.example" }), { expectedProvider: "deterministic" }), /READINESS_LOOPBACK_REQUIRED/);
    assert.throws(() => parseReadiness(JSON.stringify(input), { expectedPid: 99, expectedProvider: "deterministic" }), /READINESS_INVALID/);
    const path = join(root, "ready.json");
    await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    const credentialPath = join(root, input.credentialFile);
    await writeFile(credentialPath, "s".repeat(43) + "\n", { mode: 0o600 });
    assert.equal((await readReadiness(path, { expectedPid: 1234, expectedProvider: "deterministic" })).token, "s".repeat(43));
    await chmod(credentialPath, 0o644);
    await assert.rejects(readReadiness(path, { expectedProvider: "deterministic" }), /READINESS_PERMISSIONS/);
    await chmod(credentialPath, 0o600);
    await chmod(root, 0o755);
    await assert.rejects(readReadiness(path, { expectedProvider: "deterministic" }), /READINESS_PERMISSIONS/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("fixture/local terminal events and stale native runs cannot qualify as real evidence", () => {
  const text = [record("turn", { source: "flyx-terminal" }), record("turn", { runId: "old-run" }), record("approval", { nativeRequestIdHash: undefined }), "{broken"].map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
  const native = parseNativeEvidence(text, expected);
  assert.equal(native.records.length, 0);
  assert.equal(native.invalid, 4);
  const result = evaluateVerification({ combo, deterministic: passed, real: passed, observed, native, requirements });
  assert.equal(result.currentVerification, "deterministic-verified");
  assert.equal(result.nativeComplete, false);
});
test("full promotion requires current native turn approval interrupt recovery plus matching runtime", () => {
  const native = parseNativeEvidence(["turn", "approval", "interrupt", "recovery"].map((kind) => JSON.stringify(record(kind))).join("\n"), expected);
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

test("production readiness binds current run, build, identity, and age", () => {
  const payload = { v: 2, domain: "fixture", pid: 42, provider: "claude", baseUrl: "http://127.0.0.1:1234", credentialFile: "pairing-" + "a".repeat(32) + ".secret", observed,
    createdAt: new Date().toISOString(), runId: "run-1", entry: "production-main", entryPath: "/host/dist/main.js", entryDigest: h("a"), buildDigest: observed.runtimeDigest, sceneVersion: "flyx-c3-basic-v1" };
  const constraints = { expectedPid: 42, expectedProvider: "claude", expectedRunId: "run-1", expectedEntryDigest: h("a"), expectedHost: host, expectedDomain: "fixture" };
  assert.equal(parseReadiness(JSON.stringify(signed(payload)), constraints).entry, "production-main");
  assert.throws(() => parseReadiness(JSON.stringify(signed(payload)), { ...constraints, expectedRunId: "old" }), /READINESS_RUN_MISMATCH/);
  assert.throws(() => parseReadiness(JSON.stringify(signed(payload)), { ...constraints, expectedEntryDigest: h("b") }), /READINESS_BUILD_MISMATCH/);
  assert.throws(() => parseReadiness(JSON.stringify(signed({ ...payload, createdAt: new Date(Date.now() - 600_000).toISOString() })), constraints), /READINESS_STALE/);
  const tampered = { ...signed(payload), observed: { ...observed, adapterVersion: "forged" } };
  assert.throws(() => parseReadiness(JSON.stringify(tampered), constraints), /READINESS_SIGNATURE_INVALID/);
  assert.equal(verifySignedPayload({ ...signed(payload), host: { ...host, hostId: "22222222-2222-4222-8222-222222222222" } }), false);
});
test("canonical signatures reject tampering and old unsigned evidence; basic scope publishes only proved capabilities", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  const native = parseNativeEvidence(JSON.stringify(record("turn")), expected);
  assert.equal(native.records.length, 1);
  const result = evaluateVerification({ combo: { ...combo, capabilities: ["turn"], status: "fully-verified" }, deterministic: passed, real: passed, observed, native,
    requirements: { deterministic: { turns: 1 }, real: { turns: 1 } } });
  assert.equal(result.currentVerification, "fully-verified");
  assert.equal(result.capabilities.recovery, undefined);
  const forged = { ...record("turn"), result: "unsupported" };
  assert.equal(parseNativeEvidence(JSON.stringify(forged), expected).invalid, 1);
  assert.equal(parseNativeEvidence(JSON.stringify(record("turn", { v: 1 })), expected).invalid, 1);
  assert.equal(evaluateVerification({ combo: { ...combo, status: "fully-verified" }, deterministic: { status: "blocked", completed: 0 }, real: passed, observed, native, requirements }).status, "pending");
});

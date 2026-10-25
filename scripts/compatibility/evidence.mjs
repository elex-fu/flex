import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function extractSemver(text) { return /\b\d+\.\d+\.\d+\b/.exec(text ?? "")?.[0] ?? null; }
export function normalizedOs(value) { return String(value ?? "").replace(/^macOS\s+/i, "darwin ").replace(/^linux\s+/i, "linux ").trim().toLowerCase(); }
function fail(code) { throw Object.assign(new Error(code), { code }); }
export function parseArgs(argv, defaults = {}) {
  const options = { deterministicOnly: false, real: false, scene: "basic", ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument === "--deterministic-only") { options.deterministicOnly = true; continue; }
    if (argument === "--prepare") { options.prepare = true; continue; }
    if (argument === "--real") { options.real = true; continue; }
    const key = { "--scene": "scene", "--authorization": "authorization", "--destination-host": "destinationHost", "--run-id": "runId", "--combo": "combo", "--turns": "turns", "--config": "config", "--evidence-root": "evidenceRoot" }[argument];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("MATRIX_ARGUMENT_INVALID");
    const value = argv[++index];
    if (key === "turns") {
      const turns = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(turns) || turns < 1 || turns > 100) fail("MATRIX_TURNS_INVALID");
      options.turns = turns;
    } else if (key === "scene") {
      if (!SCENE_NAMES.has(value)) fail("MATRIX_SCENE_UNSUPPORTED");
      options.scene = value;
    } else options[key] = value;
  }
  if (options.combo && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.combo)) fail("MATRIX_COMBO_INVALID");
  if (options.runId && !/^[a-zA-Z0-9-]{1,128}$/.test(options.runId)) fail("MATRIX_RUN_INVALID");
  if (options.prepare && (options.real || options.deterministicOnly)) fail("MATRIX_ARGUMENT_CONFLICT");
  if (options.real && options.deterministicOnly) fail("MATRIX_ARGUMENT_CONFLICT");
  return options;
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail("CANONICAL_INVALID");
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
export const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");

// Script-side mirror of apps/mvp-host/src/diagnostics/compatibility-scenes.ts
// (design §4/§7). Pure data + derivations; evidence.test.mjs cross-checks the
// mirror against the built dist registry whenever dist contains it, so drift
// is caught by the tooling suite after a rebuild.
export const SCENE_BASIC_PROMPT = "回复 OK 两个字母，不要做任何其他事";
export const SCENE_APPROVAL_PROMPT = "在当前工作区创建文件 approval-scene.txt，内容为 OK，然后回复 DONE，不要做任何其他事";
export const SCENE_APPROVAL_PROMPT_2 = "在当前工作区创建文件 approval-scene.txt，内容为 DENIED，然后回复 DONE，不要做任何其他事";
export const SCENE_INTERRUPT_PROMPT = "从 1 数到 50，每数一个数字就输出一次，不要做任何其他事";
const BASIC_SEGMENT = Object.freeze({ id: "basic", prompt: SCENE_BASIC_PROMPT, repetitions: 10, commandCount: 10, capability: "turn" });
const APPROVAL_SEGMENT = Object.freeze({ id: "approval", prompt: SCENE_APPROVAL_PROMPT, prompts: Object.freeze([SCENE_APPROVAL_PROMPT, SCENE_APPROVAL_PROMPT_2]), repetitions: 2, commandCount: 2, capability: "approval" });
const INTERRUPT_SEGMENT = Object.freeze({ id: "interrupt", prompt: SCENE_INTERRUPT_PROMPT, repetitions: 1, commandCount: 1, capability: "interrupt" });
const RECONNECT_SEGMENT = Object.freeze({ id: "reconnect", prompt: SCENE_BASIC_PROMPT, repetitions: 1, commandCount: 1, capability: "reconnect" });
export const SCENE_REGISTRY = new Map([
  ["flyx-c3-basic-v1", Object.freeze([BASIC_SEGMENT])],
  ["flyx-c4-approval-v1", Object.freeze([BASIC_SEGMENT, APPROVAL_SEGMENT])],
  ["flyx-c5-interrupt-v1", Object.freeze([BASIC_SEGMENT, INTERRUPT_SEGMENT])],
  ["flyx-c6-reconnect-v1", Object.freeze([BASIC_SEGMENT, RECONNECT_SEGMENT])],
  ["flyx-c7-interactive-v1", Object.freeze([BASIC_SEGMENT, APPROVAL_SEGMENT, INTERRUPT_SEGMENT, RECONNECT_SEGMENT])],
]);
/** --scene name -> the registered sceneVersion. */
export const SCENE_NAMES = new Map([
  ["basic", "flyx-c3-basic-v1"],
  ["approval", "flyx-c4-approval-v1"],
  ["interrupt", "flyx-c5-interrupt-v1"],
  ["reconnect", "flyx-c6-reconnect-v1"],
  ["interactive", "flyx-c7-interactive-v1"],
]);
export function sceneSegments(sceneVersion) { return SCENE_REGISTRY.get(sceneVersion); }
export function sceneCommandCount(sceneVersion) { return sceneSegments(sceneVersion)?.reduce((total, segment) => total + segment.commandCount, 0) ?? 0; }
/** Flat command-id family, in consumption order (basic slots first). */
export function compatibilitySceneCommandIds(sceneVersion, runId) {
  const segments = sceneSegments(sceneVersion);
  if (!segments) fail("MATRIX_SCENE_UNSUPPORTED");
  const prefix = "compat-" + digest({ sceneVersion, runId }).slice(0, 32);
  const ids = [];
  for (const segment of segments) {
    for (let index = 1; index <= segment.commandCount; index += 1) {
      // The legacy c3 family keeps its pre-registry shape byte-for-byte.
      ids.push(sceneVersion === "flyx-c3-basic-v1" ? prefix + "-" + index : prefix + "-" + segment.id + "-" + index);
    }
  }
  return ids;
}
export function verifySignedPayload(value, expectedHost) {
  try {
    const { digest: recorded, signature, host, ...payload } = value;
    if (!host || !/^[a-f0-9-]{36}$/.test(host.hostId) || !/^[A-Za-z0-9_-]{43}$/.test(host.hostPublicKey)
      || !/^[A-Za-z0-9_-]{43}$/.test(host.signingPublicKey) || !/^[A-Za-z0-9_-]{86}$/.test(signature ?? "")) return false;
    if (host.fingerprint !== "sha256:" + digest({ v: 1, hostPublicKey: host.hostPublicKey, signingPublicKey: host.signingPublicKey })) return false;
    if (expectedHost && canonicalJson(host) !== canonicalJson(expectedHost)) return false;
    if (digest({ ...payload, host }) !== recorded) return false;
    return verify(null, Buffer.from("flyx-compatibility-v2\n" + recorded), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: host.signingPublicKey } }), Buffer.from(signature, "base64url"));
  } catch { return false; }
}
const COMPLETE_FACTS = ["providerVersion", "executablePath", "executableDigest", "configFingerprint", "adapterId", "adapterVersion", "supervisionContractId", "runtimeVersion", "runtimeDigest", "nodeVersion", "os"];
function completeArtifact(value, provider) {
  return value && COMPLETE_FACTS.every((key) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 4096)
    && isAbsolute(value.executablePath) && /^[a-f0-9]{64}$/.test(value.executableDigest) && /^[a-f0-9]{64}$/.test(value.runtimeDigest)
    && (provider !== "claude" || typeof value.sdkVersion === "string" && value.sdkVersion.length > 0);
}
export function parseReadiness(text, { expectedPid, expectedProvider, expectedRunId, expectedEntryDigest, expectedEntryPath, expectedHost, expectedSceneVersion = "flyx-c3-basic-v1", expectedDomain = "isolated-real", startedAt, now = Date.now(), maxAgeMs = 300_000 } = {}) {
  let value;
  try { value = JSON.parse(text); } catch { fail("READINESS_INVALID"); }
  const deterministic = expectedProvider === "deterministic";
  if (!value || value.v !== (deterministic ? 1 : 2) || !Number.isSafeInteger(value.pid) || value.pid < 1
    || (expectedPid !== undefined && value.pid !== expectedPid)
    || !["claude", "codex", "deterministic"].includes(value.provider)
    || (expectedProvider && value.provider !== expectedProvider)
    || !/^pairing-[a-f0-9]{32}\.secret$/.test(value.credentialFile ?? "")
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !value.observed || typeof value.observed !== "object" || Array.isArray(value.observed)) fail("READINESS_INVALID");
  if (Date.parse(value.createdAt) > now + 5_000 || Date.parse(value.createdAt) < now - maxAgeMs
    || startedAt !== undefined && Date.parse(value.createdAt) < startedAt - 1_000) fail("READINESS_STALE");
  if (!deterministic) {
    if (value.domain !== expectedDomain) fail("READINESS_DOMAIN_INVALID");
    if (!expectedRunId || value.runId !== expectedRunId) fail("READINESS_RUN_MISMATCH");
    if (value.entry !== "production-main" || !isAbsolute(value.entryPath ?? "") || !value.entryPath.endsWith("/dist/main.js")
      || !expectedEntryDigest || value.entryDigest !== expectedEntryDigest || expectedEntryPath && value.entryPath !== expectedEntryPath
      || value.buildDigest !== value.observed.runtimeDigest) fail("READINESS_BUILD_MISMATCH");
    if (value.sceneVersion !== expectedSceneVersion || !completeArtifact(value.observed, value.provider)) fail("READINESS_RUNTIME_MISMATCH");
    if (!verifySignedPayload(value, expectedHost)) fail("READINESS_SIGNATURE_INVALID");
  }
  let base;
  try { base = new URL(value.baseUrl); } catch { fail("READINESS_INVALID"); }
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") fail("READINESS_LOOPBACK_REQUIRED");
  return { ...value, baseUrl: base.origin };
}

export async function readPrivateArtifact(path, maxBytes = 65_536) {
  const parent = await lstat(dirname(resolve(path)));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && parent.uid !== process.getuid())) fail("READINESS_PERMISSIONS");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("READINESS_PERMISSIONS");
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text) > maxBytes) fail("READINESS_TOO_LARGE");
    return text;
  } finally { await file.close(); }
}
export async function readReadiness(path, expected) {
  const readiness = parseReadiness(await readPrivateArtifact(path), expected);
  const credentialPath = join(dirname(resolve(path)), readiness.credentialFile);
  const token = (await readPrivateArtifact(credentialPath, 256)).trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) fail("READINESS_CREDENTIAL_INVALID");
  if (readiness.v === 2 && createHash("sha256").update(token).digest("hex") !== readiness.credentialDigest) fail("READINESS_CREDENTIAL_MISMATCH");
  return { ...readiness, token };
}

const capabilityMatches = (kind, capability) => capability === kind || kind === "approval" && ["approval-allow", "approval-deny"].includes(capability);
const HASH = /^[a-f0-9]{64}$/;
export function parseNativeEvidence(text, { runId, provider, host, entryDigest, sceneVersion = "flyx-c3-basic-v1", artifact, domain = "isolated-real", now = Date.now(), maxAgeMs = 86_400_000 }) {
  const records = [];
  let invalid = 0;
  for (const line of text.split("\n").filter((entry) => entry.trim())) {
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || record.v !== 2 || record.domain !== domain || record.source !== "native" || record.runId !== runId || record.provider !== provider
      || !["turn", "approval", "question", "interrupt", "stop", "reconnect", "recovery", "rewind"].includes(record.kind)
      || !["passed", "failed", "skipped", "unsupported"].includes(record.result)
      || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(record.nativeEvent ?? "")
      || !/^[A-Z][A-Z0-9_]{0,95}$/.test(record.evidenceCode ?? "") || !HASH.test(record.attemptIdHash ?? "")
      || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || Date.parse(record.at) > now + 5_000 || Date.parse(record.at) < now - maxAgeMs
      || !host || !verifySignedPayload(record, host) || !entryDigest || record.entryDigest !== entryDigest || record.sceneVersion !== sceneVersion
      || !capabilityMatches(record.kind, record.capability) || !completeArtifact(record.artifact, provider) || !/^[a-z][a-z0-9._-]{0,95}$/.test(record.capability ?? "")
      || artifact && COMPLETE_FACTS.concat(provider === "claude" ? ["sdkVersion"] : []).some((key) => record.artifact[key] !== artifact[key])) { invalid += 1; continue; }
    if (domain === "isolated-real") {
      const proof = record.provenance;
      if (!proof || proof.provider !== provider || proof.attemptIdHash !== record.attemptIdHash || !HASH.test(proof.launchRecordDigest ?? "")
        || !HASH.test(proof.nativeObservationDigest ?? "") || ["interrupt", "stop"].includes(record.kind) && !HASH.test(proof.stopRecordDigest ?? "")
        || ["executableDigest", "runtimeDigest", "configFingerprint", "supervisionContractId"].some((key) => proof[key] !== record.artifact[key])) { invalid += 1; continue; }
    }
    const hashes = ["nativeSessionIdHash", "nativeTurnIdHash", "nativeResultIdHash", "nativeRequestIdHash"];
    if (hashes.some((key) => record[key] !== undefined && !HASH.test(record[key]))) { invalid += 1; continue; }
    if (record.result === "passed" && (!record.nativeSessionIdHash || !record.launchRef
      || (["turn", "interrupt", "stop"].includes(record.kind) && !(provider === "claude" ? record.nativeResultIdHash : record.nativeTurnIdHash))
      || (["approval", "question"].includes(record.kind) && !record.nativeRequestIdHash)
      || (["interrupt", "stop"].includes(record.kind) && !record.stopRef))) { invalid += 1; continue; }
    records.push(record);
  }
  return { records, invalid };
}

export function nativeCounts(records) {
  return Object.fromEntries(["turn", "approval", "question", "interrupt", "stop", "reconnect", "recovery", "rewind"].map((kind) => [
    kind, new Set(records.filter((record) => record.kind === kind && record.result === "passed").map((record) => kind === "approval" ? record.nativeSessionIdHash + ":" + record.nativeRequestIdHash : record.provider === "claude" && record.nativeResultIdHash ? record.nativeSessionIdHash + ":" + record.nativeResultIdHash : record.nativeTurnIdHash ? record.nativeSessionIdHash + ":" + record.nativeTurnIdHash : record.attemptIdHash)).size,
  ]));
}
export function environmentMatches(combo, observed) {
  const reasons = [];
  if (!combo.nodeVersion) reasons.push("NODE_VERSION_UNVERIFIED");
  if (!combo.os) reasons.push("OS_UNVERIFIED");
  if (!(combo.provider === "codex" ? combo.codexCliVersion : combo.claudeCliVersion)) reasons.push("CLI_VERSION_UNVERIFIED");
  if (combo.provider !== "codex" && !combo.sdkVersion) reasons.push("SDK_VERSION_UNVERIFIED");
  for (const [expected, actual] of [["nodeVersion", "nodeVersion"], ["sdkVersion", "sdkVersion"], [combo.provider === "codex" ? "codexCliVersion" : "claudeCliVersion", "cliVersion"]]) {
    if (combo[expected] && combo[expected] !== observed?.[actual]) reasons.push(expected.toUpperCase() + "_MISMATCH");
  }
  if (combo.os && normalizedOs(combo.os) !== normalizedOs(observed?.os)) reasons.push("OS_MISMATCH");
  if (!observed?.executablePath || !isAbsolute(observed.executablePath) || !observed?.cliVersion) reasons.push("EXECUTABLE_UNVERIFIED");
  if (!["signed_in", "api_key"].includes(observed?.authMode)) reasons.push("AUTH_MODE_UNVERIFIED");
  if (!completeArtifact(observed, combo.provider)) reasons.push("RUNTIME_ARTIFACT_UNVERIFIED");
  for (const key of ["executableDigest", "adapterId", "adapterVersion", "runtimeVersion", "runtimeDigest", "supervisionContractId"]) if (combo[key] && combo[key] !== observed?.[key]) reasons.push(key.toUpperCase() + "_MISMATCH");
  return { matched: reasons.length === 0, reasonCodes: reasons };
}
export function evaluateVerification({ combo, deterministic, real, native, observed, requirements, sceneVersion = "flyx-c3-basic-v1" }) {
  const counts = nativeCounts(native.records);
  // Per-scene required native counts (design §7): the basic baseline stays 10
  // turns; interactive segments add approvals/interrupts/reconnects as the
  // scene (or its per-scene config realRequirements) requires.
  const sceneCounts = sceneSegments(sceneVersion)?.reduce((required, segment) => {
    if (segment.id === "approval") required.approvals = Math.max(required.approvals, segment.repetitions);
    if (segment.id === "interrupt") required.interrupts = Math.max(required.interrupts, segment.repetitions);
    if (segment.id === "reconnect") required.reconnects = Math.max(required.reconnects, segment.repetitions);
    return required;
  }, { approvals: 0, interrupts: 0, reconnects: 0, recoveries: 0 }) ?? { approvals: 0, interrupts: 0, reconnects: 0, recoveries: 0 };
  const required = { turns: 10, ...sceneCounts, ...requirements.real };
  const kindRequirements = { turn: required.turns, approval: required.approvals, interrupt: required.interrupts, reconnect: required.reconnects, recovery: required.recoveries };
  const declared = combo.capabilities ?? ["turn"];
  const capabilities = Object.fromEntries([...new Set(native.records.map((record) => record.capability))].filter(Boolean).map((capability) => [capability, native.records.some((record) => record.capability === capability && record.result === "passed")]));
  const environment = environmentMatches(combo, observed);
  const detQualifies = deterministic.status === "passed" && deterministic.completed >= (requirements.deterministic?.turns ?? 10);
  const nativeComplete = native.invalid === 0 && declared.every((capability) => capabilities[capability]) && Object.entries(kindRequirements).every(([kind, count]) => counts[kind] >= count);
  const failures = deterministic.status === "failed" || real.status === "failed" || native.records.some((record) => record.result === "failed");
  const currentVerification = failures ? "broken" : detQualifies && real.status === "passed" && real.completed >= required.turns && environment.matched && nativeComplete ? "fully-verified" : detQualifies ? "deterministic-verified" : "pending";
  const status = currentVerification; // Persisted/manual status cannot preserve a verdict the current evidence does not prove.
  return { status, currentVerification, counts, capabilities, nativeComplete, invalidEvidence: native.invalid, environment };
}

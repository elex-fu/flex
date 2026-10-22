import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function extractSemver(text) { return /\b\d+\.\d+\.\d+\b/.exec(text ?? "")?.[0] ?? null; }
export function normalizedOs(value) { return String(value ?? "").replace(/^macOS\s+/i, "darwin ").replace(/^linux\s+/i, "linux ").trim().toLowerCase(); }
function fail(code) { throw Object.assign(new Error(code), { code }); }
export function parseArgs(argv, defaults = {}) {
  const options = { deterministicOnly: false, real: false, ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument === "--deterministic-only") { options.deterministicOnly = true; continue; }
    if (argument === "--prepare") { options.prepare = true; continue; }
    if (argument === "--real") { options.real = true; continue; }
    const key = { "--authorization": "authorization", "--destination-host": "destinationHost", "--run-id": "runId", "--combo": "combo", "--turns": "turns", "--config": "config", "--evidence-root": "evidenceRoot" }[argument];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("MATRIX_ARGUMENT_INVALID");
    const value = argv[++index];
    if (key === "turns") {
      const turns = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(turns) || turns < 1 || turns > 100) fail("MATRIX_TURNS_INVALID");
      options.turns = turns;
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
export function compatibilitySceneCommandIds(runId) { const prefix = "compat-" + digest({ sceneVersion: "flyx-c3-basic-v1", runId }).slice(0,32); return Array.from({length:10},(_,index)=>prefix+"-"+(index+1)); }
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
export function evaluateVerification({ combo, deterministic, real, native, observed, requirements }) {
  const counts = nativeCounts(native.records);
  const required = { turns: 10, approvals: 0, interrupts: 0, recoveries: 0, ...requirements.real };
  const declared = combo.capabilities ?? ["turn"];
  const capabilities = Object.fromEntries([...new Set(native.records.map((record) => record.capability))].filter(Boolean).map((capability) => [capability, native.records.some((record) => record.capability === capability && record.result === "passed")]));
  const environment = environmentMatches(combo, observed);
  const detQualifies = deterministic.status === "passed" && deterministic.completed >= (requirements.deterministic?.turns ?? 10);
  const nativeComplete = native.invalid === 0 && declared.every((capability) => capabilities[capability]) && ["turn", "approval", "interrupt", "recovery"].every((kind) => counts[kind] >= required[{ turn: "turns", approval: "approvals", interrupt: "interrupts", recovery: "recoveries" }[kind]]);
  const failures = deterministic.status === "failed" || real.status === "failed" || native.records.some((record) => record.result === "failed");
  const currentVerification = failures ? "broken" : detQualifies && real.status === "passed" && real.completed >= required.turns && environment.matched && nativeComplete ? "fully-verified" : detQualifies ? "deterministic-verified" : "pending";
  const status = currentVerification; // Persisted/manual status cannot preserve a verdict the current evidence does not prove.
  return { status, currentVerification, counts, capabilities, nativeComplete, invalidEvidence: native.invalid, environment };
}

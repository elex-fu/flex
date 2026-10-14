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
    if (argument === "--real") { options.real = true; continue; }
    const key = { "--combo": "combo", "--turns": "turns", "--config": "config", "--evidence-root": "evidenceRoot" }[argument];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--")) fail("MATRIX_ARGUMENT_INVALID");
    const value = argv[++index];
    if (key === "turns") {
      const turns = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(turns) || turns < 1 || turns > 100) fail("MATRIX_TURNS_INVALID");
      options.turns = turns;
    } else options[key] = value;
  }
  if (options.combo && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.combo)) fail("MATRIX_COMBO_INVALID");
  if (options.real && options.deterministicOnly) fail("MATRIX_ARGUMENT_CONFLICT");
  return options;
}

export function parseReadiness(text, { expectedPid, expectedProvider } = {}) {
  let value;
  try { value = JSON.parse(text); } catch { fail("READINESS_INVALID"); }
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
    || (expectedPid !== undefined && value.pid !== expectedPid)
    || !["claude", "codex", "deterministic"].includes(value.provider)
    || (expectedProvider && value.provider !== expectedProvider)
    || !/^pairing-[a-f0-9]{32}\.secret$/.test(value.credentialFile ?? "")
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !value.observed || typeof value.observed !== "object" || Array.isArray(value.observed)) fail("READINESS_INVALID");
  let base;
  try { base = new URL(value.baseUrl); } catch { fail("READINESS_INVALID"); }
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== "/") fail("READINESS_LOOPBACK_REQUIRED");
  const observed = {};
  for (const key of ["sdkVersion", "cliVersion", "adapterVersion", "nodeVersion", "os"]) {
    if (value.observed[key] !== undefined) {
      if (typeof value.observed[key] !== "string" || value.observed[key].length > 128) fail("READINESS_INVALID");
      observed[key] = value.observed[key];
    }
  }
  if (value.observed.executablePath !== undefined) {
    if (typeof value.observed.executablePath !== "string" || value.observed.executablePath.length > 4096 || /[\x00-\x1f]/.test(value.observed.executablePath)) fail("READINESS_INVALID");
    observed.executablePath = value.observed.executablePath;
  }
  observed.authMode = ["unknown", "signed_in", "api_key", "loopback_test"].includes(value.observed.authMode) ? value.observed.authMode : "unknown";
  const capabilities = value.observed.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.length > 64 || capabilities.some((capability) => typeof capability !== "string" || !/^[a-z][a-z0-9._-]{0,95}$/.test(capability))) fail("READINESS_INVALID");
  observed.capabilities = capabilities;
  return { v: 1, pid: value.pid, baseUrl: base.origin, provider: value.provider, credentialFile: value.credentialFile, createdAt: value.createdAt, observed };
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
  return { ...readiness, token };
}

const HASH = /^[a-f0-9]{64}$/;
export function parseNativeEvidence(text, { runId, provider }) {
  const records = [];
  let invalid = 0;
  for (const line of text.split("\n").filter((entry) => entry.trim())) {
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || record.v !== 1 || record.source !== "native" || record.runId !== runId || record.provider !== provider
      || !["turn", "approval", "interrupt", "recovery"].includes(record.kind)
      || !["passed", "failed", "skipped", "unsupported"].includes(record.result)
      || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(record.nativeEvent ?? "")
      || !/^[A-Z][A-Z0-9_]{0,95}$/.test(record.evidenceCode ?? "") || !HASH.test(record.attemptIdHash ?? "")
      || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) { invalid += 1; continue; }
    const hashes = ["nativeSessionIdHash", "nativeTurnIdHash", "nativeRequestIdHash"];
    if (hashes.some((key) => record[key] !== undefined && !HASH.test(record[key]))) { invalid += 1; continue; }
    // A local approval boolean/interrupt request is never native settlement.
    if (record.result === "passed" && (!record.nativeSessionIdHash
      || (record.kind === "approval" && !record.nativeRequestIdHash))) { invalid += 1; continue; }
    const safe = Object.fromEntries(["v", "source", "runId", "provider", "kind", "result", "nativeEvent", "evidenceCode", "attemptIdHash", ...hashes, "at"].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
    records.push(safe);
  }
  return { records, invalid };
}
export function nativeCounts(records) {
  return Object.fromEntries(["turn", "approval", "interrupt", "recovery"].map((kind) => [
    kind, new Set(records.filter((record) => record.kind === kind && record.result === "passed").map((record) => kind === "approval" ? record.nativeSessionIdHash + ":" + record.nativeRequestIdHash : record.nativeTurnIdHash ? record.nativeSessionIdHash + ":" + record.nativeTurnIdHash : record.attemptIdHash)).size,
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
  if ((combo.capabilities ?? []).some((capability) => !(observed?.capabilities ?? []).includes(capability))) reasons.push("CAPABILITY_UNVERIFIED");
  return { matched: reasons.length === 0, reasonCodes: reasons };
}
export function evaluateVerification({ combo, deterministic, real, native, observed, requirements }) {
  const counts = nativeCounts(native.records);
  const required = { turns: 10, approvals: 10, interrupts: 10, recoveries: 1, ...requirements.real };
  const environment = environmentMatches(combo, observed);
  const detQualifies = deterministic.status === "passed" && deterministic.completed >= (requirements.deterministic?.turns ?? 10);
  const nativeComplete = native.invalid === 0 && ["turn", "approval", "interrupt", "recovery"].every((kind) => counts[kind] >= required[{ turn: "turns", approval: "approvals", interrupt: "interrupts", recovery: "recoveries" }[kind]]);
  const failures = deterministic.status === "failed" || real.status === "failed" || native.records.some((record) => record.result === "failed");
  const currentVerification = failures ? "broken" : detQualifies && real.status === "passed" && real.completed >= required.turns && environment.matched && nativeComplete ? "fully-verified" : detQualifies ? "deterministic-verified" : "pending";
  const rank = { pending: 0, "deterministic-verified": 1, "fully-verified": 2 };
  const status = currentVerification === "broken" || (rank[currentVerification] ?? -1) > (rank[combo.status] ?? -1) ? currentVerification : combo.status;
  return { status, currentVerification, counts, nativeComplete, invalidEvidence: native.invalid, environment };
}

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, chmod, lstat, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedProcessRegistry, type ManagedProcessRecord } from "./managed-process-registry.js";
import { NativeBoundaryError, prepareNativeExecutionBoundary, macosPrivateBoundaryProfile, linuxPrivateBoundaryArguments, type NativeBoundaryLaunchEvidence, type NativeBoundaryOptions, type NativeBoundaryProcessRegistry, type NativeExecutionBoundary } from "./native-execution-boundary.js";
import { inspectNativeBoundaryStop, isNativeBoundaryProof, nativeIdentityDigest, type NativeBoundaryProof } from "./native-boundary-proof.js";
import type { ProcessIdentity, ProcessInspector } from "./process-inspector.js";

const roots: string[] = [], boundaries: NativeExecutionBoundary[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const boundary of boundaries.splice(0)) await boundary.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flyx-native-boundary-test-")); roots.push(root);
  const workspace = join(root, "workspace"), nativeState = join(root, "native-state");
  const privateRoots = ["host-data", "host-identity", "relay-registration", "machine-coordination"].map((name) => join(root, name));
  for (const path of [workspace, nativeState, ...privateRoots]) await mkdir(path, { mode: 0o700 });
  const files = privateRoots.map((path) => join(path, "sentinel"));
  for (const [index, file] of files.entries()) await writeFile(file, "private-sentinel-" + index, { mode: 0o600 });
  const alias = join(workspace, "private-alias"); await symlink(files[0]!, alias);
  const options: NativeBoundaryOptions = { workspaceRoot: workspace, nativeStateRoots: [nativeState], privateRoots, temporaryRoot: root };
  return { root, workspace, nativeState, privateRoots, files, alias, options };
}
async function prepared(options: NativeBoundaryOptions) {
  const assessment = await prepareNativeExecutionBoundary(options);
  if (!assessment.ready) throw new Error("Kernel boundary unavailable: " + assessment.code);
  boundaries.push(assessment.boundary); return assessment.boundary;
}
function registry() {
  const records: ManagedProcessRecord[] = [], evidence: NativeBoundaryLaunchEvidence[] = [];
  const processes = new ManagedProcessRegistry({ journal: { save(record) { records.push({ ...record }); } }, context: () => ({ hostOwnerId: "local-test", hostOwnerGeneration: 1, runtimeId: "boundary-probe", runtimeGeneration: 1, attemptId: "local-test" }), spawn: ((command: string, args: readonly string[], options: SpawnOptions) => { expect(records.at(-1)?.state).toBe("launching"); return spawn(command, args, options); }) as unknown as typeof spawn });
  const wrapped: NativeBoundaryProcessRegistry = { spawn(command, args, options, proof) { evidence.push(proof); const child = processes.spawn(command, args, options, proof); children.push(child); return child; } };
  return { wrapped, processes, records, evidence };
}
async function output(child: ChildProcess): Promise<{ stdout: string; code: number | null }> {
  let stdout = ""; child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr?.resume();
  return new Promise((resolveResult, reject) => { child.once("error", reject); child.once("close", (code) => resolveResult({ stdout, code })); });
}
const supported = process.platform === "darwin" || process.platform === "linux";

describe("native private-data execution boundary", () => {
  it.runIf(supported)("enforces actual private read/write and symlink denial inherited by child tools", async () => {
    const f = await fixture(), boundary = await prepared(f.options), managed = registry();
    // Same UID and mode 0700 allow the unwrapped Host to read every sentinel.
    expect(await readFile(f.files[0]!, "utf8")).toBe("private-sentinel-0");
    const code = String.raw`const fs=require('node:fs'),cp=require('node:child_process');const p=JSON.parse(process.argv[1]);const attempt=(file,w)=>{try{w?fs.writeFileSync(file,'overwritten'):fs.readFileSync(file);return false}catch(e){return ['EPERM','EACCES','ENOENT','EROFS'].includes(e.code)}};const local=p.files.map(file=>({read:attempt(file,false),write:attempt(file,true)}));const descendant=cp.spawnSync(process.execPath,['-e','const fs=require("node:fs");const p=JSON.parse(process.argv[1]);let denied=0;for(const file of p.files){try{fs.readFileSync(file)}catch{denied++}}console.log(denied)',JSON.stringify(p)],{encoding:'utf8'});console.log(JSON.stringify({local,aliasRead:attempt(p.alias,false),aliasWrite:attempt(p.alias,true),childDenied:Number(descendant.stdout.trim())}));`;
    const child = boundary.spawn(managed.wrapped, { command: process.execPath, args: ["-e", code, JSON.stringify({ files: f.files, alias: f.alias })], cwd: f.workspace, env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const result = await output(child); expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ local: f.files.map(() => ({ read: true, write: true })), aliasRead: true, aliasWrite: true, childDenied: 4 });
    for (const [index, file] of f.files.entries()) expect(await readFile(file, "utf8")).toBe("private-sentinel-" + index);
    expect(managed.evidence).toHaveLength(1); expect(managed.evidence[0]!.proof).toBe(boundary.proof); expect(managed.evidence[0]!.launchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(managed.records.some((record) => record.state === "root_exited")).toBe(true);
    if (process.platform === "darwin") { expect(boundary.proof.treeIsolation).toBe("unverified"); expect(boundary.proof.verifiedDescendantStop).toBe(false); expect((await managed.processes.closeAndWait(0)).treeStopped).toBe(false); }
  });

  it.runIf(supported)("preserves original argument values, cwd, filtered environment, SDK signal and pipe stdio", async () => {
    const f = await fixture(), boundary = await prepared(f.options), managed = registry(), controller = new AbortController();
    const values = ["argument with spaces", "$(literal)", "quote\"literal"], env = { ONLY_FOR_NATIVE: "value with spaces", HOME: f.nativeState };
    const code = "console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:process.env.ONLY_FOR_NATIVE,hostEnv:process.env.SHOULD_NOT_INHERIT}));";
    process.env.SHOULD_NOT_INHERIT = "host-secret";
    try {
      const request = { command: process.execPath, args: ["-e", code, ...values], cwd: f.workspace, env, signal: controller.signal, stdio: ["pipe", "pipe", "pipe"] as SpawnOptions["stdio"] };
      const plan = boundary.plan(request); expect(plan.options.signal).toBe(controller.signal); expect(plan.options.cwd).toBe(request.cwd); expect(plan.options.env).toEqual(env); expect(plan.options.stdio).toBe(request.stdio);
      const result = await output(boundary.spawn(managed.wrapped, request)); expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ argv: values, cwd: await realpath(f.workspace), env: env.ONLY_FOR_NATIVE });
    } finally { delete process.env.SHOULD_NOT_INHERIT; }
  });

  it.runIf(supported)("binds owner-only generated policy and public evidence without leaking paths or env secrets", async () => {
    const f = await fixture(), boundary = await prepared(f.options);
    const plan = boundary.plan({ command: process.execPath, args: ["-e", ""], cwd: f.workspace, env: { API_KEY: "local-secret" } });
    const profile = process.platform === "darwin" ? plan.args[1]! : (await readdir(f.root)).filter((name) => name.startsWith("flyx-native-boundary-")).map((name) => join(f.root, name, "profiles", "policy.json"))[0]!;
    expect((await lstat(profile)).mode & 0o777).toBe(0o600); expect((await lstat(dirname(dirname(profile)))).mode & 0o777).toBe(0o700);
    expect(isNativeBoundaryProof(boundary.proof)).toBe(true); expect(Object.isFrozen(boundary.proof)).toBe(true);
    const publicValue = JSON.stringify(boundary.publicSummary()); expect(publicValue).not.toContain(f.root); expect(publicValue).not.toContain("local-secret");
    await chmod(profile, 0o644); expect(boundary.publicSummary()).toMatchObject({ ready: false, code: "NATIVE_BOUNDARY_CHANGED" }); expect(() => boundary.plan({ command: process.execPath, args: [], cwd: f.workspace, env: {} })).toThrow("NATIVE_BOUNDARY_CHANGED");
  });

  it.runIf(supported)("rejects changed roots, symlink cwd escapes and wrapper pre-loader variables before spawn", async () => {
    const f = await fixture(), boundary = await prepared(f.options), managed = registry();
    const external = join(f.workspace, "outside"); await symlink(f.privateRoots[0]!, external);
    const request = { command: process.execPath, args: ["-e", ""], cwd: f.workspace, env: {} };
    expect(() => boundary.spawn(managed.wrapped, { ...request, cwd: external })).toThrow("NATIVE_BOUNDARY_SPAWN_INVALID");
    expect(() => boundary.spawn(managed.wrapped, { ...request, env: { LD_PRELOAD: join(f.workspace, "evil.so") } })).toThrow("NATIVE_BOUNDARY_SPAWN_INVALID");
    await chmod(f.privateRoots[0]!, 0o755); expect(() => boundary.spawn(managed.wrapped, request)).toThrow("NATIVE_BOUNDARY_CHANGED"); expect(managed.records).toEqual([]);
  });

  it("rejects registered workspace/native-state overlap with canonical private roots", async () => {
    const f = await fixture();
    const alias = join(f.root, "private-root-alias"); await symlink(f.workspace, alias);
    for (const privateRoots of [[f.workspace], [f.nativeState], [alias]]) {
      const assessment = await prepareNativeExecutionBoundary({ ...f.options, privateRoots });
      expect(assessment).toMatchObject({ ready: false, code: "NATIVE_BOUNDARY_POLICY_INVALID" }); expect(JSON.stringify(assessment)).not.toContain(f.root);
    }
  });

  it("fails closed when a backend is absent or a local executable attempts to impersonate it", async () => {
    const f = await fixture(), fake = join(f.root, "sandbox-exec"), marker = join(f.root, "fake-ran");
    await writeFile(fake, "#!/bin/sh\ntouch " + marker + "\n", { mode: 0o755 });
    const missing = await prepareNativeExecutionBoundary({ ...f.options, backendExecutable: join(f.root, "missing") });
    expect(missing).toMatchObject({ ready: false, code: supported ? "NATIVE_BOUNDARY_BACKEND_UNAVAILABLE" : "NATIVE_BOUNDARY_PLATFORM_UNSUPPORTED" });
    const impersonated = await prepareNativeExecutionBoundary({ ...f.options, backendExecutable: fake });
    expect(impersonated).toMatchObject({ ready: false, code: supported ? "NATIVE_BOUNDARY_BACKEND_UNTRUSTED" : "NATIVE_BOUNDARY_PLATFORM_UNSUPPORTED" }); expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
  });

  it.runIf(supported)("cleans only the locally generated profile and refuses further launches after disposal", async () => {
    const f = await fixture(), boundary = await prepared(f.options), generated = (await readdir(f.root)).find((name) => name.startsWith("flyx-native-boundary-"))!;
    await boundary.dispose(); expect(await lstat(join(f.root, generated)).catch(() => undefined)).toBeUndefined(); expect(await readFile(f.files[0]!, "utf8")).toBe("private-sentinel-0");
    expect(boundary.publicSummary()).toMatchObject({ ready: false, code: "NATIVE_BOUNDARY_CLOSED" }); expect(() => boundary.plan({ command: process.execPath, args: [], cwd: f.workspace, env: {} })).toThrow("NATIVE_BOUNDARY_CLOSED");
  });

  it.runIf(process.platform === "darwin")("keeps an escaped child sandboxed and refuses group absence as a descendant stop proof", async () => {
    const f = await fixture(), boundary = await prepared(f.options), managed = registry();
    const ready = join(f.workspace, "escaped-ready"), done = join(f.workspace, "escaped-done");
    const descendant = `const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(f.files[0])})}catch{denied=true}fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,denied}));setTimeout(()=>fs.writeFileSync(${JSON.stringify(done)},'done'),800);`;
    const parent = `const fs=require('node:fs'),cp=require('node:child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();const wait=()=>{if(fs.existsSync(${JSON.stringify(ready)})){console.log('root-exited');process.exit(0)}else setTimeout(wait,5)};wait();`;
    const child = boundary.spawn(managed.wrapped, { command: process.execPath, args: ["-e", parent], cwd: f.workspace, env: {} });
    expect((await output(child)).code).toBe(0);
    const escaped = JSON.parse(await readFile(ready, "utf8")) as { pid: number; denied: boolean };
    expect(escaped.denied).toBe(true); expect(() => process.kill(escaped.pid, 0)).not.toThrow();
    expect(() => process.kill(-child.pid!, 0)).toThrow();
    expect((await managed.processes.closeAndWait(0)).treeStopped).toBe(false);
    const deadline = Date.now() + 3_000;
    while (!await lstat(done).catch(() => undefined) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(await readFile(done, "utf8")).toBe("done");
  });

  it("constructs strict Linux namespace/capability flags with only explicit writable roots and API networking retained", () => {
    const args = linuxPrivateBoundaryArguments({ workspaceRoot: "/work/repo", nativeStateRoots: ["/provider/state"], privateRoots: ["/host/data", "/host/identity"] }, "/usr/bin/provider", ["arg with spaces"], "/work/repo");
    expect(args).toContain("--unshare-user"); expect(args).toContain("--unshare-pid"); expect(args).toContain("--die-with-parent"); expect(args).toContain("--cap-drop"); expect(args).toContain("--disable-userns"); expect(args).toContain("--assert-userns-disabled");
    expect(args).not.toContain("--as-pid-1"); expect(args).not.toContain("--unshare-net"); expect(args).not.toContain("--not-a-security-boundary");
    expect(args.slice(-3)).toEqual(["--", "/usr/bin/provider", "arg with spaces"]);
    expect(args.join(" ")).toContain("--ro-bind / / --bind /work/repo /work/repo --bind /provider/state /provider/state"); expect(args.join(" ")).toContain("--tmpfs /host/data --chmod 000 /host/data"); expect(args).toContain("--proc");
  });

  it("escapes local profile literals and never alters native permission or approval policy", () => {
    const profile = macosPrivateBoundaryProfile(['/private/host "data"', "/private/identity"]);
    expect(profile).toContain('(deny file-read* file-write* (subpath "/private/host \\"data\\""))'); expect(profile).toContain("(allow default)"); expect(profile).not.toContain("network");
    expect(() => macosPrivateBoundaryProfile(["/private/host\n(injected)"])).toThrow(NativeBoundaryError);
  });
});

const syntheticProof: NativeBoundaryProof = { version: 1, boundaryId: "11111111-1111-4111-8111-111111111111", platform: "linux", kernelRelease: "synthetic", backend: "linux_bubblewrap", backendVersion: "0.12.0", backendDigest: "a".repeat(64), policyDigest: "b".repeat(64), evidenceDigest: "c".repeat(64), verifiedPrivateReadBoundary: true, verifiedPrivateWriteBoundary: true, verifiedChildInheritance: true, treeIsolation: "linux_pid_namespace", verifiedDescendantStop: true };
const linuxIdentity: ProcessIdentity = { pid: 42, platform: "linux", birth: { kind: "linux", bootId: "22222222-2222-4222-8222-222222222222", startTicks: "100" } };
function inspector(state: "alive" | "exited" | "unknown"): ProcessInspector { return { currentIdentity: () => linuxIdentity, inspect: () => ({ state, reason: "synthetic contract test" }) }; }
describe("native boundary proof validation", () => {
  it("never promotes macOS group/root exit to full-tree stop", () => {
    const mac = { ...syntheticProof, platform: "darwin", backend: "macos_seatbelt", treeIsolation: "unverified", verifiedDescendantStop: false };
    expect(isNativeBoundaryProof(mac)).toBe(true); expect(inspectNativeBoundaryStop(mac, { pid: 42, platform: "darwin" }, inspector("exited"), () => true)).toEqual({ state: "unknown" });
    expect(isNativeBoundaryProof({ ...mac, verifiedDescendantStop: true })).toBe(false);
  });
  it("requires trusted original launch proof and kernel birth before accepting a synthetic Linux stop contract", () => {
    expect(inspectNativeBoundaryStop(syntheticProof, linuxIdentity, inspector("exited"), () => false)).toEqual({ state: "unknown" });
    expect(inspectNativeBoundaryStop(syntheticProof, { pid: 42, platform: "linux" }, inspector("exited"), () => true)).toEqual({ state: "unknown" });
    expect(inspectNativeBoundaryStop(syntheticProof, { ...linuxIdentity, birth: { kind: "linux", bootId: "invalid", startTicks: "100" } }, inspector("exited"), () => true)).toEqual({ state: "unknown" });
    expect(inspectNativeBoundaryStop(syntheticProof, linuxIdentity, inspector("exited"), () => { throw new Error("stored proof unreadable"); })).toEqual({ state: "unknown" });
    const result = inspectNativeBoundaryStop(syntheticProof, linuxIdentity, inspector("exited"), () => true);
    expect(result).toMatchObject({ state: "stopped", identityDigest: nativeIdentityDigest(linuxIdentity), contractId: "native-boundary/v1/linux_bubblewrap/" + syntheticProof.evidenceDigest });
    expect(inspectNativeBoundaryStop(syntheticProof, linuxIdentity, inspector("alive"), () => true)).toEqual({ state: "running" }); expect(inspectNativeBoundaryStop(syntheticProof, linuxIdentity, inspector("unknown"), () => true)).toEqual({ state: "unknown" });
  });
});

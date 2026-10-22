import { spawn, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { measurePlannedNativeArtifact, type PlannedNativeArtifact } from "../diagnostics/planned-native-artifact.js";
import { SystemProcessInspector, type ProcessIdentity } from "./process-inspector.js";
import type { ManagedChildHandle } from "./managed-child-handle.js";
import { NativeBoundaryError, type NativeBoundaryBackend, type NativeBoundaryPlatform, type NativeBoundaryProof, type NativeBoundaryPublicSummary, type NativeBoundaryReadinessCode } from "./native-boundary-proof.js";
export { NativeBoundaryError, inspectNativeBoundaryStop, isNativeBoundaryProof, nativeIdentityDigest } from "./native-boundary-proof.js";
export type { NativeBoundaryProof, NativeBoundaryPublicSummary, NativeBoundaryReadinessCode } from "./native-boundary-proof.js";

export type NativeBoundaryOptions = {
  workspaceRoot: string;
  nativeStateRoots: readonly string[];
  /** Include DB data, Host identity, Relay registration and machine coordination directories. */
  privateRoots: readonly string[];
  temporaryRoot?: string;
  /** Locally configured, root-owned executable. No client executable/path selection. */
  backendExecutable?: string;
};
export type NativeBoundarySpawnRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Already filtered by the Provider adapter. Never merges the Host environment. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdio?: SpawnOptions["stdio"];
  windowsHide?: boolean;
  killSignal?: SpawnOptions["killSignal"];
  argv0?: string;
};
export type NativeBoundaryLaunchEvidence = { proof: NativeBoundaryProof; launchDigest: string; plannedArtifact?: PlannedNativeArtifact };
export interface NativeBoundaryProcessRegistry {
  spawn(command: string, args: readonly string[], options: SpawnOptions, evidence: NativeBoundaryLaunchEvidence): ManagedChildHandle;
}
export type NativeBoundaryLaunchPlan = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  proof: NativeBoundaryProof;
  launchDigest: string;
  plannedArtifact?: PlannedNativeArtifact;
};
export type NativeBoundaryAssessment =
  | { ready: true; boundary: NativeExecutionBoundary; proof: NativeBoundaryProof; summary: NativeBoundaryPublicSummary }
  | { ready: false; code: NativeBoundaryReadinessCode; summary: NativeBoundaryPublicSummary };
type Root = { path: string; identity: string };
type Backend = Root & { digest: string; version: string; kind: NativeBoundaryBackend };
type Probe = {
  directRead: boolean; directWrite: boolean; aliasRead: boolean; aliasWrite: boolean;
  childRead: boolean; childWrite: boolean; childAliasRead: boolean; childAliasWrite: boolean;
  privateRoots: boolean; workspaceWritable: boolean; nativeStateWritable: boolean;
  namespace?: string; capsDropped?: boolean; userNamespacesDisabled?: boolean;
};
const VERSION = 1;
const SELF_TEST_TIMEOUT_MS = 8_000;
const REQUIRED_PROBES = ["directRead", "directWrite", "aliasRead", "aliasWrite", "childRead", "childWrite", "childAliasRead", "childAliasWrite", "privateRoots", "workspaceWritable", "nativeStateWritable"] as const;
const PRELOAD_ENV = /^(?:DYLD_|LD_|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$)/;
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); }
function overlap(left: string, right: string): boolean { return inside(left, right) || inside(right, left); }
function identity(path: string): string { const s = lstatSync(path); return [s.dev, s.ino, s.mode, s.uid].join(":"); }
function directory(path: string): Root {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
  const canonical = realpathSync(resolve(path)), s = lstatSync(canonical);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
  return { path: canonical, identity: identity(canonical) };
}
function uniqueRoots(paths: readonly string[]): Root[] { return [...new Map(paths.map((path) => { const root = directory(path); return [root.path, root] as const; })).values()].sort((a, b) => a.path.localeCompare(b.path)); }
function assertRoot(root: Root): void {
  if (realpathSync(root.path) !== root.path || identity(root.path) !== root.identity) throw new NativeBoundaryError("NATIVE_BOUNDARY_CHANGED");
}
function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env || typeof env !== "object" || Object.entries(env).some(([name, value]) => value !== undefined && (typeof value !== "string" || name.includes("\0") || value.includes("\0") || PRELOAD_ENV.test(name)))) throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
  return { ...env };
}
function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (typeof command !== "string" || !command || command.includes("\0")) throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
  const candidates = command.includes("/") ? [resolve(cwd, command)] : (env.PATH ?? "/usr/bin:/bin").split(":").map((part) => resolve(part || cwd, command));
  for (const candidate of candidates) {
    try { const path = realpathSync(candidate), s = statSync(path); if (s.isFile() && (s.mode & 0o111)) return path; } catch { /* try the next configured PATH entry */ }
  }
  throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
}

/** Extra deny rules only; the Provider's own sandbox and permission mode remain in force. */
export function macosPrivateBoundaryProfile(privateRoots: readonly string[]): string {
  if (!privateRoots.length || privateRoots.some((path) => !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
  return ["(version 1)", "(allow default)", ...privateRoots.map((path) => "(deny file-read* file-write* (subpath " + JSON.stringify(path) + "))"), ""].join("\n");
}
/** Minimum bubblewrap 0.12: includes the absolute-symlink setup fix. Runtime probes still decide support.
 * https://github.com/containers/bubblewrap/blob/main/NEWS.md */
export function linuxPrivateBoundaryArguments(roots: { workspaceRoot: string; nativeStateRoots: readonly string[]; privateRoots: readonly string[] }, command: string, args: readonly string[], cwd: string): string[] {
  return ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/",
    ...[roots.workspaceRoot, ...roots.nativeStateRoots].flatMap((path) => ["--bind", path, path]),
    ...roots.privateRoots.flatMap((path) => ["--tmpfs", path, "--chmod", "000", path]),
    "--proc", "/proc", "--dev", "/dev", "--chdir", cwd, "--", command, ...args];
}

/** A prepared boundary is immutable and has passed a fixed local, non-Provider kernel probe. */
export class NativeExecutionBoundary {
  private disposed = false;
  private constructor(
    private readonly platform: NativeBoundaryPlatform,
    private readonly workspace: Root,
    private readonly states: Root[],
    private readonly privateRoots: Root[],
    private readonly generated: Root,
    private readonly profile: { path: string; digest: string; identity: string },
    private readonly backend: Backend,
    readonly proof: NativeBoundaryProof,
  ) {}
  publicSummary(): NativeBoundaryPublicSummary {
    let code: NativeBoundaryReadinessCode = "NATIVE_BOUNDARY_READY";
    try { this.assertCurrent(); } catch (error) { code = error instanceof NativeBoundaryError ? error.code : "NATIVE_BOUNDARY_CHANGED"; }
    return Object.freeze({ ready: code === "NATIVE_BOUNDARY_READY", code, platform: this.platform, backend: this.backend.kind, proof: this.proof });
  }
  private assertCurrent(): void {
    if (this.disposed) throw new NativeBoundaryError("NATIVE_BOUNDARY_CLOSED");
    try {
      for (const root of [this.workspace, ...this.states, ...this.privateRoots, this.generated, this.backend]) assertRoot(root);
      if (hash(readFileSync(this.backend.path)) !== this.backend.digest || identity(this.profile.path) !== this.profile.identity || hash(readFileSync(this.profile.path)) !== this.profile.digest) throw new NativeBoundaryError("NATIVE_BOUNDARY_CHANGED");
    } catch { throw new NativeBoundaryError("NATIVE_BOUNDARY_CHANGED"); }
  }
  plan(request: NativeBoundarySpawnRequest): NativeBoundaryLaunchPlan {
    this.assertCurrent();
    if (!request || typeof request.cwd !== "string" || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
    let cwd: string;
    try { cwd = realpathSync(resolve(request.cwd)); if (!statSync(cwd).isDirectory()) throw new Error(); }
    catch { throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID"); }
    const env = safeEnvironment(request.env);
    if (!inside(this.workspace.path, cwd)) throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
    const originalExecutable = resolveExecutable(request.command, cwd, env);
    if (this.privateRoots.some((root) => inside(root.path, originalExecutable))) throw new NativeBoundaryError("NATIVE_BOUNDARY_SPAWN_INVALID");
    const args = this.wrap(originalExecutable, request.args, cwd);
    const options: SpawnOptions = { cwd: request.cwd, env, stdio: request.stdio ?? ["pipe", "pipe", "pipe"], signal: request.signal, windowsHide: request.windowsHide, killSignal: request.killSignal, argv0: request.argv0 };
    const launchDigest = hash(JSON.stringify({ version: VERSION, policyDigest: this.proof.policyDigest, backendDigest: this.backend.digest, command: originalExecutable, args: request.args, cwd, env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)), stdio: typeof options.stdio === "string" ? options.stdio : options.stdio?.map((item) => typeof item === "object" ? "stream" : item), argv0: request.argv0 }));
    return { command: this.backend.path, args, options, proof: this.proof, launchDigest, plannedArtifact: measurePlannedNativeArtifact({ executable: originalExecutable, args: request.args, cwd, env }) };
  }
  /** The registry commits the fourth-argument evidence with its launching row before OS spawn. */
  spawn(registry: NativeBoundaryProcessRegistry, request: NativeBoundarySpawnRequest): ManagedChildHandle {
    const plan = this.plan(request);
    return registry.spawn(plan.command, plan.args, plan.options, { proof: plan.proof, launchDigest: plan.launchDigest, ...(plan.plannedArtifact ? { plannedArtifact: plan.plannedArtifact } : {}) });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Only remove this locally generated root after matching its original inode.
    assertRoot(this.generated);
    await rm(this.generated.path, { recursive: true, force: false });
  }
  private wrap(command: string, args: readonly string[], cwd: string): string[] {
    return this.platform === "darwin" ? ["-f", this.profile.path, "--", command, ...args]
      : linuxPrivateBoundaryArguments({ workspaceRoot: this.workspace.path, nativeStateRoots: this.states.map((root) => root.path), privateRoots: [...this.privateRoots.map((root) => root.path), join(this.generated.path, "profiles"), join(this.generated.path, "probe-private")] }, command, args, cwd);
  }
  static async prepare(options: NativeBoundaryOptions): Promise<NativeBoundaryAssessment> {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") return unavailable(platform, "NATIVE_BOUNDARY_PLATFORM_UNSUPPORTED");
    let generated: Root | undefined;
    try {
      const workspace = directory(options.workspaceRoot), states = uniqueRoots(options.nativeStateRoots), allPrivateRoots = uniqueRoots(options.privateRoots);
      // A single parent mount/deny covers nested private directories without recreating hidden children.
      const privateRoots = allPrivateRoots.filter((root) => !allPrivateRoots.some((parent) => parent !== root && inside(parent.path, root.path)));
      if (!privateRoots.length || privateRoots.some((root) => overlap(root.path, workspace.path) || states.some((state) => overlap(root.path, state.path)))) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
      const backend = await verifyBackend(platform, options.backendExecutable);
      if (privateRoots.some((root) => inside(root.path, backend.path) || inside(root.path, process.execPath))) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
      const temporary = directory(options.temporaryRoot ?? tmpdir());
      const path = await mkdtemp(join(temporary.path, "flyx-native-boundary-")); await chmod(path, 0o700); generated = directory(path);
      if ([workspace, ...states, ...privateRoots].some((root) => overlap(root.path, path))) throw new NativeBoundaryError("NATIVE_BOUNDARY_POLICY_INVALID");
      const profiles = join(path, "profiles"), probePrivate = join(path, "probe-private"), probeWorkspace = join(path, "probe-workspace"), probeState = join(path, "probe-state");
      for (const directory of [profiles, probePrivate, probeWorkspace, probeState]) await mkdir(directory, { mode: 0o700 });
      const sentinel = join(probePrivate, "sentinel"), alias = join(probeWorkspace, "private-alias"), nonce = randomUUID();
      await writeFile(sentinel, nonce, { flag: "wx", mode: 0o600 }); await symlink(sentinel, alias);
      const deniedPaths = [...privateRoots.map((root) => root.path), profiles, probePrivate];
      const policy = platform === "darwin" ? macosPrivateBoundaryProfile(deniedPaths) : JSON.stringify({ version: VERSION, privateRoots: deniedPaths, workspaceRoot: workspace.path, nativeStateRoots: states.map((root) => root.path), flags: linuxPrivateBoundaryArguments({ workspaceRoot: workspace.path, nativeStateRoots: states.map((root) => root.path), privateRoots: deniedPaths }, "COMMAND", [], "CWD") });
      const profilePath = join(profiles, "policy" + (platform === "darwin" ? ".sb" : ".json"));
      await writeFile(profilePath, policy, { flag: "wx", mode: 0o600 });
      const wrap = (command: string, args: readonly string[], cwd: string) => ({ command: backend.path, args: platform === "darwin" ? ["-f", profilePath, "--", command, ...args] : linuxPrivateBoundaryArguments({ workspaceRoot: workspace.path, nativeStateRoots: [...states.map((root) => root.path), probeWorkspace, probeState], privateRoots: deniedPaths }, command, args, cwd) });
      const result = await runPrivateProbe(wrap, { sentinel, alias, workspace: probeWorkspace, state: probeState, roots: privateRoots.map((root) => root.path), nonce }, platform).catch(() => { throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED"); });
      if (!REQUIRED_PROBES.every((key) => result.probe[key] === true) || await readFile(sentinel, "utf8") !== nonce) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
      let treeVerified = false;
      if (platform === "linux") {
        treeVerified = result.treeVerified;
        if (!treeVerified || !result.probe.capsDropped || !result.probe.userNamespacesDisabled) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
      }
      assertRoot(backend);
      if (hash(readFileSync(backend.path)) !== backend.digest) throw new NativeBoundaryError("NATIVE_BOUNDARY_CHANGED");
      const proof: NativeBoundaryProof = Object.freeze({ version: VERSION, boundaryId: randomUUID(), platform, kernelRelease: release(), backend: backend.kind, backendVersion: backend.version, backendDigest: backend.digest, policyDigest: hash(policy), evidenceDigest: hash(JSON.stringify({ version: VERSION, kernelRelease: release(), backendDigest: backend.digest, policyDigest: hash(policy), probeProgramDigest: hash(PROBE_PROGRAM), probe: result.probe, treeVerified, nonce })), verifiedPrivateReadBoundary: true, verifiedPrivateWriteBoundary: true, verifiedChildInheritance: true, treeIsolation: treeVerified ? "linux_pid_namespace" : "unverified", verifiedDescendantStop: treeVerified });
      // Keep the exact tested profile; obsolete probe names remain denied after cleanup.
      for (const directory of [probeWorkspace, probeState, probePrivate]) await rm(directory, { recursive: true, force: false });
      const boundary = new NativeExecutionBoundary(platform, workspace, states, privateRoots, generated, { path: profilePath, digest: hash(policy), identity: identity(profilePath) }, backend, proof);
      return { ready: true, boundary, proof, summary: boundary.publicSummary() };
    } catch (error) {
      if (generated) { try { assertRoot(generated); await rm(generated.path, { recursive: true, force: false }); } catch { /* never delete a replaced generated root */ } }
      return unavailable(platform, error instanceof NativeBoundaryError ? error.code : "NATIVE_BOUNDARY_POLICY_INVALID");
    }
  }
}
export const prepareNativeExecutionBoundary = NativeExecutionBoundary.prepare;
function unavailable(platform: NodeJS.Platform, code: NativeBoundaryReadinessCode): NativeBoundaryAssessment { return { ready: false, code, summary: Object.freeze({ ready: false, code, platform }) }; }

async function verifyBackend(platform: NativeBoundaryPlatform, configured?: string): Promise<Backend> {
  let path: string;
  try { path = realpathSync(configured ?? (platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap")); }
  catch { throw new NativeBoundaryError("NATIVE_BOUNDARY_BACKEND_UNAVAILABLE"); }
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || !(s.mode & 0o111) || s.mode & 0o6000 || platform === "darwin" && path !== "/usr/bin/sandbox-exec") throw new NativeBoundaryError("NATIVE_BOUNDARY_BACKEND_UNTRUSTED");
  const digest = hash(readFileSync(path));
  let version = "seatbelt-kernel:" + release();
  if (platform === "linux") {
    const { code, stdout } = await capture(path, ["--version"], "/", {});
    const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout.trim());
    if (code !== 0 || !match || Number(match[1]) === 0 && Number(match[2]) < 12) throw new NativeBoundaryError("NATIVE_BOUNDARY_BACKEND_UNTRUSTED");
    version = match[1] + "." + match[2] + "." + match[3];
  }
  return { path, identity: identity(path), digest, version, kind: platform === "darwin" ? "macos_seatbelt" : "linux_bubblewrap" };
}

const PROBE_PROGRAM = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const p = JSON.parse(process.argv[1]);
function deniedRead(path) { try { fs.readFileSync(path); return false; } catch (error) { return ['EPERM','EACCES','ENOENT'].includes(error.code); } }
function deniedWrite(path) { try { fs.writeFileSync(path,'changed'); return false; } catch (error) { return ['EPERM','EACCES','ENOENT','EROFS'].includes(error.code); } }
function writable(root) { try { fs.writeFileSync(root + '/writable','ok',{flag:'wx',mode:0o600}); return fs.readFileSync(root + '/writable','utf8') === 'ok'; } catch { return false; } }
const childCode = 'const fs=require("node:fs");const p=JSON.parse(process.argv[1]);const d=(path,w)=>{try{w?fs.writeFileSync(path,"changed"):fs.readFileSync(path);return false}catch(e){return ["EPERM","EACCES","ENOENT","EROFS"].includes(e.code)}};console.log(JSON.stringify({read:d(p.sentinel,false),write:d(p.sentinel,true),aliasRead:d(p.alias,false),aliasWrite:d(p.alias,true)}))';
const child = cp.spawnSync(process.execPath,['-e',childCode,JSON.stringify(p)],{encoding:'utf8',timeout:2000});
let inherited={};try{inherited=JSON.parse(child.stdout)}catch{}
const result = {nonce:p.nonce,directRead:deniedRead(p.sentinel),directWrite:deniedWrite(p.sentinel),aliasRead:deniedRead(p.alias),aliasWrite:deniedWrite(p.alias),childRead:inherited.read===true,childWrite:inherited.write===true,childAliasRead:inherited.aliasRead===true,childAliasWrite:inherited.aliasWrite===true,privateRoots:p.roots.every(root=>{try{fs.readdirSync(root);return false}catch(e){return ['EPERM','EACCES','ENOENT'].includes(e.code)}}),workspaceWritable:writable(p.workspace),nativeStateWritable:writable(p.state)};
if(process.platform==='linux') {
  result.namespace=fs.readlinkSync('/proc/self/ns/pid');
  result.capsDropped=/^CapEff:\s*0+$/m.test(fs.readFileSync('/proc/self/status','utf8'));
  result.userNamespacesDisabled=Number(fs.readFileSync('/proc/sys/user/max_user_namespaces','utf8').trim())<=1;
  cp.spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'}).unref();
  console.log(JSON.stringify(result));setTimeout(()=>{},15000);
} else console.log(JSON.stringify(result));
`;
async function runPrivateProbe(
  wrap: (command: string, args: readonly string[], cwd: string) => { command: string; args: string[] },
  input: { sentinel: string; alias: string; workspace: string; state: string; roots: string[]; nonce: string },
  platform: NativeBoundaryPlatform,
): Promise<{ probe: Probe; treeVerified: boolean }> {
  const plan = wrap(process.execPath, ["-e", PROBE_PROGRAM, JSON.stringify(input)], input.workspace);
  if (platform === "darwin") {
    const result = await capture(plan.command, plan.args, input.workspace, {});
    if (result.code !== 0) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
    const parsed = JSON.parse(result.stdout) as Probe & { nonce?: string };
    if (parsed.nonce !== input.nonce) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
    const { nonce: _nonce, ...probe } = parsed;
    return { probe, treeVerified: false };
  }
  // This test kills only the exact ChildProcess handle it launched. The escaped
  // descendant remains in the new PID namespace and must disappear with it.
  const child = spawn(plan.command, plan.args, { cwd: input.workspace, env: {}, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stderr?.resume();
  let output = "", timer: ReturnType<typeof setTimeout> | undefined;
  let exited = false; child.once("exit", () => { exited = true; });
  try {
    const parsed = await new Promise<Probe & { nonce?: string }>((resolveResult, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")));
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 32_768) reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")); const end = output.indexOf("\n"); if (end >= 0) { try { resolveResult(JSON.parse(output.slice(0, end))); } catch { reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")); } } });
      timer = setTimeout(() => reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")), SELF_TEST_TIMEOUT_MS);
    });
    if (timer) clearTimeout(timer);
    const namespace = parsed.namespace;
    if (parsed.nonce !== input.nonce || typeof namespace !== "string" || !/^pid:\[\d+\]$/.test(namespace) || namespace === await readlink("/proc/self/ns/pid")) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
    const members = await namespaceMembers(namespace);
    if (members.length < 3 || members.some((identity) => !identity.birth)) throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
    child.kill("SIGKILL");
    const inspector = new SystemProcessInspector(), deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (exited && (await namespaceMembers(namespace)).length === 0 && members.every((identity) => inspector.inspect(identity).state === "exited")) { const { nonce: _nonce, ...probe } = parsed; return { probe, treeVerified: true }; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED");
  } finally { if (timer) clearTimeout(timer); if (!exited) child.kill("SIGKILL"); }
}
async function namespaceMembers(namespace: string): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  for (const entry of await readdir("/proc")) if (/^\d+$/.test(entry)) {
    try { if (await readlink("/proc/" + entry + "/ns/pid") === namespace) result.push(new SystemProcessInspector({ pid: Number(entry) }).currentIdentity()); } catch { /* process exited during enumeration */ }
  }
  return result;
}
async function capture(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr?.resume();
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 32_768) { child.kill("SIGKILL"); reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")); } });
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", (code) => { if (timer) clearTimeout(timer); resolveResult({ code, stdout: output }); });
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(new NativeBoundaryError("NATIVE_BOUNDARY_SELF_TEST_FAILED")); }, SELF_TEST_TIMEOUT_MS);
  });
}

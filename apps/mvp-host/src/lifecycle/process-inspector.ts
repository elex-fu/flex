import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export type ProcessIdentity = {
  pid: number;
  platform: NodeJS.Platform;
  /** macOS identity is an ordinary local observation, not a race-free kernel handle. */
  birth?: { kind: "linux"; bootId: string; startTicks: string } | { kind: "macos"; bootId: string; startTime: string };
};

export type ProcessInspection = { state: "alive" | "exited" | "unknown"; reason: string };

export interface ProcessInspector {
  currentIdentity(): ProcessIdentity;
  inspect(identity: ProcessIdentity): ProcessInspection;
}

export type ProcessInspectorOptions = {
  platform?: NodeJS.Platform;
  pid?: number;
  signal?: (pid: number) => void;
  read?: (path: string) => string;
  exec?: (command: string, args: readonly string[]) => string;
  /** Actual ordinary launches only; SQL/history ownership never invokes ps/sysctl. */
  observeMacosBirth?: boolean;
};

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** Fail closed when permission or process birth cannot be verified. */
export class SystemProcessInspector implements ProcessInspector {
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly signal: (pid: number) => void;
  private readonly read: (path: string) => string;
  private readonly exec: (command: string, args: readonly string[]) => string;
  private readonly observeMacosBirth: boolean;

  constructor(options: ProcessInspectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.signal = options.signal ?? ((pid) => { process.kill(pid, 0); });
    this.read = options.read ?? ((path) => readFileSync(path, "utf8"));
    this.exec = options.exec ?? ((command, args) => execFileSync(command, [...args], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }));
    this.observeMacosBirth = options.observeMacosBirth === true;
  }

  currentIdentity(): ProcessIdentity {
    return { pid: this.pid, platform: this.platform, ...(this.platform === "darwin" && this.observeMacosBirth ? this.macosBirth(this.pid) : this.linuxBirth(this.pid)) };
  }

  inspect(identity: ProcessIdentity): ProcessInspection {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.platform !== this.platform) {
      return { state: "unknown", reason: "invalid_or_foreign_process_identity" };
    }
    if (identity.birth && (!/^[a-f0-9-]{36}$/i.test(identity.birth.bootId)
      || identity.birth.kind === "linux" && (identity.platform !== "linux" || !/^\d+$/.test(identity.birth.startTicks))
      || identity.birth.kind === "macos" && (identity.platform !== "darwin" || typeof identity.birth.startTime !== "string" || !identity.birth.startTime)
      || !["linux", "macos"].includes(identity.birth.kind))) {
      return { state: "unknown", reason: "process_birth_invalid" };
    }
    try {
      this.signal(identity.pid);
    } catch (error) {
      if (code(error) === "ESRCH") return { state: "exited", reason: "pid_does_not_exist" };
      return { state: "unknown", reason: code(error) === "EPERM" ? "permission_denied" : "pid_probe_failed" };
    }
    if (identity.birth?.kind === "macos" && this.platform === "darwin") {
      const current = this.macosBirth(identity.pid).birth;
      if (!current) return { state: "unknown", reason: "process_birth_unverified" };
      return current.bootId === identity.birth.bootId && current.startTime === identity.birth.startTime
        ? { state: "alive", reason: "managed_macos_identity_observed" }
        : { state: "exited", reason: "recorded_process_exited_pid_reused" };
    }
    // A live PID without an original birth observation cannot identify an old process.
    if (!identity.birth || identity.birth.kind !== "linux" || this.platform !== "linux") {
      return { state: "unknown", reason: "process_birth_not_supported" };
    }
    const current = this.linuxBirth(identity.pid).birth;
    if (!current) return { state: "unknown", reason: "process_birth_unverified" };
    if (current.bootId !== identity.birth.bootId || current.startTicks !== identity.birth.startTicks) {
      return { state: "exited", reason: "recorded_process_exited_pid_reused" };
    }
    return { state: "alive", reason: "verified_process_birth" };
  }

  private macosBirth(pid: number): { birth?: Extract<NonNullable<ProcessIdentity["birth"]>, { kind: "macos" }> } {
    try {
      const bootId = this.exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).trim();
      const startTime = this.exec("/bin/ps", ["-p", String(pid), "-o", "lstart="]).trim().replace(/\s+/g, " ");
      if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(startTime)) return {};
      return { birth: { kind: "macos", bootId, startTime } };
    } catch { return {}; }
  }

  private linuxBirth(pid: number): { birth?: Extract<NonNullable<ProcessIdentity["birth"]>, { kind: "linux" }> } {
    if (this.platform !== "linux") return {};
    try {
      const bootId = this.read("/proc/sys/kernel/random/boot_id").trim();
      const stat = this.read(`/proc/${pid}/stat`);
      // comm can contain spaces and parentheses; parse after its final ')'.
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19]; // field 22, with state (field 3) at index 0
      if (close < 0 || !/^[a-f0-9-]{36}$/i.test(bootId) || !startTicks || !/^\d+$/.test(startTicks)) return {};
      return { birth: { kind: "linux", bootId, startTicks } };
    } catch {
      return {};
    }
  }
}

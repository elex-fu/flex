import { readFileSync } from "node:fs";

export type ProcessIdentity = {
  pid: number;
  platform: NodeJS.Platform;
  /** Linux kernel identity; no wall clock / ps timestamp is accepted as birth proof. */
  birth?: { kind: "linux"; bootId: string; startTicks: string };
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

  constructor(options: ProcessInspectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pid = options.pid ?? process.pid;
    this.signal = options.signal ?? ((pid) => { process.kill(pid, 0); });
    this.read = options.read ?? ((path) => readFileSync(path, "utf8"));
  }

  currentIdentity(): ProcessIdentity {
    return { pid: this.pid, platform: this.platform, ...this.linuxBirth(this.pid) };
  }

  inspect(identity: ProcessIdentity): ProcessInspection {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.platform !== this.platform) {
      return { state: "unknown", reason: "invalid_or_foreign_process_identity" };
    }
    try {
      this.signal(identity.pid);
    } catch (error) {
      if (code(error) === "ESRCH") return { state: "exited", reason: "pid_does_not_exist" };
      return { state: "unknown", reason: code(error) === "EPERM" ? "permission_denied" : "pid_probe_failed" };
    }
    // A live PID alone cannot prove it is the process recorded in a previous
    // invocation. macOS's common ps output only has second precision and is
    // deliberately not promoted to a strong identity here.
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

  private linuxBirth(pid: number): Pick<ProcessIdentity, "birth"> {
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

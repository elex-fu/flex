import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

type ProbeCase = {
  mode: string;
  rootResult: { code: number | null };
  originalGroupAbsent?: boolean;
  descendantAlive?: boolean;
  rootExitedBeforeRelease?: boolean;
  leaf?: {
    pid: number;
    group: number;
    session: number;
    changeResult: number;
    changeErrno: number;
    privateDenied: boolean;
    heldOpen: boolean;
  };
  completion?: { wroteAfterRootExit: boolean; privateDenied: boolean };
  launchError?: { stage: string; errno: number };
  error?: string;
  kernelEvent?: {
    registrationErrno: number;
    fallbackRegistrationErrno: number;
    rootForkObserved: boolean;
    forkEventData: number;
    rootExitObserved: boolean;
    automaticChildEvents: number;
  };
};
type Report = {
  privateBoundaryReady: boolean;
  verifiedDescendantStop: boolean;
  treeIsolation: string;
  sourceDigest: string;
  cases: ProbeCase[];
  policyCases: Array<{ operation: string; results: ProbeCase[] }>;
  observer: {
    noteTrackUnsupportedHeader: boolean;
    endpointSecurity: { result: number; notPrivileged: boolean };
  };
  revokedWorkspace: ProbeCase;
  heldContents: string;
};

describe.runIf(process.platform === "darwin")("actual macOS Native stop-contract limits", () => {
  let report: Report;
  beforeAll(async () => {
    const script = resolve(process.cwd(), "../../scripts/native-stop-contract/macos-probe.mjs");
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      timeout: 45_000,
      maxBuffer: 256 * 1024,
    });
    report = JSON.parse(stdout) as Report;
  }, 50_000);

  it.each(["setsid", "setpgid", "double-fork", "spawn-setsid"])(
    "%s retains a live writer after root exit and group disappearance",
    (mode) => {
      const probe = report.cases.find(entry => entry.mode === mode)!;
      expect(probe).toMatchObject({
        rootResult: { code: 0 },
        rootExitedBeforeRelease: true,
        originalGroupAbsent: true,
        descendantAlive: true,
        leaf: { changeErrno: 0, privateDenied: true },
        completion: { wroteAfterRootExit: true, privateDenied: true },
      });
      expect(probe.leaf!.group).toBe(probe.leaf!.pid);
      if (mode === "setpgid") expect(probe.leaf!.changeResult).toBe(0);
      else expect(probe.leaf!.session).toBe(probe.leaf!.pid);
      expect(report.privateBoundaryReady).toBe(true);
      expect(report.verifiedDescendantStop).toBe(false);
      expect(report.treeIsolation).toBe("unverified");
    },
  );

  it("rejects guessed group/session policy names and setcontrol denial still permits escape", () => {
    for (const operation of ["process-setsid", "process-setpgid", "process-set-session"]) {
      const probe = report.policyCases.find(policy => policy.operation === operation)!.results[0]!;
      expect(probe.rootResult.code).toBe(65);
      expect(probe.error).toContain("unbound variable: " + operation);
    }
    expect(report.policyCases.find(policy => policy.operation === "process-info-setcontrol")!.results[0]).toMatchObject({
      rootResult: { code: 0 },
      originalGroupAbsent: true,
      completion: { wroteAfterRootExit: true },
    });
  });

  it("denies both fork and POSIX spawn when child creation is disabled", () => {
    expect(report.policyCases.find(policy => policy.operation === "process-fork")!.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: "setsid",
        launchError: expect.objectContaining({ stage: "fork", errno: 1 }),
      }),
      expect.objectContaining({
        mode: "spawn-setsid",
        launchError: expect.objectContaining({ stage: "posix_spawn_setsid", errno: 1 }),
      }),
    ]));
  });

  it("cannot derive full-tree evidence from kqueue root events or unprivileged EndpointSecurity", () => {
    expect(report.observer.noteTrackUnsupportedHeader).toBe(true);
    expect(report.cases.find(probe => probe.mode === "kqueue-track")!.kernelEvent).toMatchObject({
      registrationErrno: 45,
      fallbackRegistrationErrno: 0,
      rootForkObserved: true,
      forkEventData: 0,
      rootExitObserved: true,
      automaticChildEvents: 0,
    });
    expect(report.cases.find(probe => probe.mode === "kqueue-track")!.completion?.wroteAfterRootExit).toBe(true);
    expect(report.observer.endpointSecurity.result).not.toBe(0);
  });

  it("cannot revoke a writable descriptor by renaming its workspace and chmodding the directory", () => {
    expect(report.revokedWorkspace).toMatchObject({
      originalGroupAbsent: true,
      rootExitedBeforeRelease: true,
      descendantAlive: true,
      leaf: { heldOpen: true },
      completion: { wroteAfterRootExit: true, privateDenied: true },
    });
    expect(report.heldContents).toBe("before\nafter-root-exit\n");
    expect(report.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

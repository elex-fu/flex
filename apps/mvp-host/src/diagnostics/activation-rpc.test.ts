import { chmodSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_FIXTURE_VALID_UNTIL, captureError, createActivationFixture, disposeActivationFixtures, type ActivationFixture,
} from "../test-support/activation-fixture.js";
import { HostActivationLoad, type ActivationLoadStore } from "../lifecycle/host-activation-load.js";
import {
  EXECUTION_READINESS_MAX_TARGETS, HOST_EXECUTION_READINESS_CAPABILITY, HOST_EXECUTION_READINESS_RPC_SCOPES, hostExecutionReadinessRpc,
} from "./activation-rpc.js";

const processes = vi.hoisted(() => ({
  execFile: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execFileSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  spawn: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
  execSync: vi.fn(() => { throw new Error("Subprocess forbidden in activation"); }),
}));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), ...processes }));

beforeEach(() => { for (const process of Object.values(processes)) process.mockClear(); });
afterEach(() => { disposeActivationFixtures(); });
function noProcesses() { for (const process of Object.values(processes)) expect(process).not.toHaveBeenCalled(); }

const METHOD = "host.getExecutionReadiness";
const SCOPES: ReadonlySet<string> = new Set(["host:read"]);
const REQUEST = { targets: [{ workspaceId: "workspace", providerInstanceId: "provider" }] } as const;

async function activated() {
  const f = createActivationFixture();
  f.writePassedEvidence();
  const service = f.service();
  const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-rpc" });
  service.activate({ evidenceId: verified.evidenceId, commandId: "activate-rpc" });
  return { f, verified };
}

function bindings(f: ActivationFixture, overrides: Partial<Parameters<typeof hostExecutionReadinessRpc>[0]> = {}) {
  return { load: f.load, catalog: f.catalog, now: () => new Date("2026-10-18T01:00:00.000Z"), ...overrides };
}

describe("host.getExecutionReadiness", () => {
  it("projects a valid pair with shared evidence, revisions and intersected capabilities", async () => {
    const { f, verified } = await activated();
    const response = hostExecutionReadinessRpc(bindings(f), METHOD, REQUEST, SCOPES);
    expect(HOST_EXECUTION_READINESS_CAPABILITY).toBe("host-execution-readiness-v1");
    expect(HOST_EXECUTION_READINESS_RPC_SCOPES).toEqual({ [METHOD]: "host:read" });
    expect(response).toEqual({
      v: 1, generatedAt: "2026-10-18T01:00:00.000Z", hostState: "ready", reasonCodes: [],
      targets: [{
        workspaceId: "workspace", providerInstanceId: "provider",
        resourceRevisions: { workspace: 1, provider: 1 },
        capabilities: ["streamingText", "workspaceWrite"],
        reasonCodes: [], evidenceId: verified.evidenceId, validUntil: ACTIVATION_FIXTURE_VALID_UNTIL,
      }],
    });
    noProcesses();
  }, 20000);

  it("reports a changed provider read-only with precise reasons and no capabilities", async () => {
    const { f } = await activated();
    writeFileSync(f.executable, "#!/bin/sh\nexit 1\n");
    chmodSync(f.executable, 0o700);
    const response = hostExecutionReadinessRpc(bindings(f), METHOD, REQUEST, SCOPES);
    expect(response.hostState).toBe("read_only");
    expect(response.reasonCodes).toEqual(["PROVIDER_EXECUTABLE_CHANGED"]);
    expect(response.targets[0]).toMatchObject({
      resourceRevisions: { workspace: 1, provider: 1 }, capabilities: [], reasonCodes: ["PROVIDER_EXECUTABLE_CHANGED"],
    });
    expect(response.targets[0]?.evidenceId).toBeUndefined();
    expect(response.targets[0]?.validUntil).toBeUndefined();
    // The projection changed nothing: readiness is re-checked at every execution path.
    expect(f.catalog.workspace("workspace")?.state).toBe("active");
    expect(f.catalog.provider("provider")?.state).toBe("configured");
    noProcesses();
  }, 20000);

  it("prefers recovery over draining and reports an unavailable schema fail-closed", async () => {
    const { f } = await activated();
    const recovered = hostExecutionReadinessRpc(bindings(f, { owner: { recoveryOnly: true }, draining: () => true }), METHOD, REQUEST, SCOPES);
    expect(recovered.hostState).toBe("recovery_required");
    expect(recovered.reasonCodes).toEqual(["HOST_RECOVERY_REQUIRED"]);
    expect(recovered.targets[0]).toMatchObject({ reasonCodes: [] });
    expect(recovered.targets[0]?.evidenceId).toBeDefined();
    const retained = hostExecutionReadinessRpc(bindings(f, { owner: { recoveryOnly: false, retainedReason: "retained-scope" } }), METHOD, REQUEST, SCOPES);
    expect(retained.hostState).toBe("recovery_required");
    const unreachableGate = hostExecutionReadinessRpc(bindings(f, { restorePending: () => { throw new Error("gate unreadable"); } }), METHOD, REQUEST, SCOPES);
    expect(unreachableGate.hostState).toBe("recovery_required");
    const draining = hostExecutionReadinessRpc(bindings(f, { draining: () => true }), METHOD, REQUEST, SCOPES);
    expect(draining.hostState).toBe("draining");
    expect(draining.reasonCodes).toEqual(["HOST_DRAINING"]);

    const withdrawals: string[] = [];
    const store: ActivationLoadStore = {
      available: false, recordReadiness: () => 0, recordDigests: () => ({ readinessRevision: 0 }),
      referencedOperation: () => undefined, withdrawReadiness: (kind, id) => { withdrawals.push(`${kind}:${id}`); },
    };
    const schemaLoad = new HostActivationLoad(store, f.observation({ supervision: f.supervision, runtime: f.runtime, evidencePath: f.evidencePath }));
    const unavailable = hostExecutionReadinessRpc(bindings(f, { load: schemaLoad }), METHOD, REQUEST, SCOPES);
    expect(unavailable.hostState).toBe("read_only");
    expect(unavailable.reasonCodes).toEqual(["ACTIVATION_SCHEMA_UNAVAILABLE"]);
    expect(unavailable.targets[0]?.reasonCodes).toEqual(["ACTIVATION_SCHEMA_UNAVAILABLE"]);
    expect(withdrawals).toEqual([]);
    noProcesses();
  }, 20000);

  it("refuses the wrong method or scope and validates the request strictly", async () => {
    const { f } = await activated();
    expect(captureError(() => hostExecutionReadinessRpc(bindings(f), "host.other", REQUEST, SCOPES))).toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(captureError(() => hostExecutionReadinessRpc(bindings(f), METHOD, REQUEST, new Set()))).toMatchObject({ code: "FORBIDDEN" });
    expect(() => hostExecutionReadinessRpc(bindings(f), METHOD, { targets: [] }, SCOPES)).toThrow();
    expect(() => hostExecutionReadinessRpc(bindings(f), METHOD, { targets: new Array(EXECUTION_READINESS_MAX_TARGETS + 1).fill({ workspaceId: "workspace", providerInstanceId: "provider" }) }, SCOPES)).toThrow();
    expect(() => hostExecutionReadinessRpc(bindings(f), METHOD, { targets: [{ workspaceId: "workspace" }] }, SCOPES)).toThrow();
    expect(() => hostExecutionReadinessRpc(bindings(f), METHOD, { targets: [{ workspaceId: "workspace", providerInstanceId: "provider", extra: 1 }] }, SCOPES)).toThrow();
    const unknown = captureError(() => hostExecutionReadinessRpc(bindings(f), METHOD, { targets: [{ workspaceId: "missing", providerInstanceId: "provider" }] }, SCOPES));
    expect(unknown).toMatchObject({ code: "ACTIVATION_RESOURCES_UNVERIFIED" });
    noProcesses();
  }, 20000);

  it("keeps a repeated target the only read of an otherwise untouched Store", async () => {
    const { f } = await activated();
    const changes = f.store.db.prepare("SELECT total_changes() AS n").get();
    const response = hostExecutionReadinessRpc(bindings(f), METHOD, {
      targets: [{ workspaceId: "workspace", providerInstanceId: "provider" }, { workspaceId: "workspace", providerInstanceId: "provider" }],
    }, SCOPES);
    expect(response.targets).toHaveLength(2);
    expect(response.hostState).toBe("ready");
    expect(f.store.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    noProcesses();
  }, 20000);
});

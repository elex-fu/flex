import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_FIXTURE_NOW, ACTIVATION_FIXTURE_VALID_UNTIL, createActivationFixture, disposeActivationFixtures,
} from "../test-support/activation-fixture.js";
import {
  HostActivationLoad, activationReadinessPort, activationWithdrawalRequired,
  type ActivationLoadStore,
} from "./host-activation-load.js";

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

/** One fixture with a fully verified and activated pair. */
async function activated() {
  const f = createActivationFixture();
  f.writePassedEvidence();
  const service = f.service();
  const verified = await service.verify({ workspaceId: "workspace", providerInstanceId: "provider", commandId: "verify-load" });
  service.activate({ evidenceId: verified.evidenceId, commandId: "activate-load" });
  return { f, verified };
}

describe("HostActivationLoad startup verdicts", () => {
  it("reports the recorded binding as valid with its evidence identity until it expires", async () => {
    const { f, verified } = await activated();
    expect(f.load.available).toBe(true);
    const workspace = f.load.workspace(f.catalog.workspace("workspace")!);
    expect(workspace).toEqual({
      state: "valid", ready: true, resourceKind: "workspace", resourceId: "workspace", readinessRevision: 1,
      reasonCodes: [], evidenceId: verified.evidenceId, validUntil: ACTIVATION_FIXTURE_VALID_UNTIL,
    });
    const provider = f.load.provider(f.catalog.provider("provider")!);
    expect(provider).toMatchObject({ state: "valid", ready: true, resourceId: "provider", evidenceId: verified.evidenceId, validUntil: ACTIVATION_FIXTURE_VALID_UNTIL });
    expect(activationWithdrawalRequired(workspace)).toBe(false);
    expect(f.load.scan(f.readinessScan()).every((verdict) => verdict.ready)).toBe(true);
    f.setNow("2026-10-19T00:00:00.001Z");
    const expired = f.load.provider(f.catalog.provider("provider")!);
    expect(expired).toMatchObject({ state: "stale", ready: false, reasonCodes: ["ACTIVATION_EVIDENCE_EXPIRED"] });
    expect(activationWithdrawalRequired(expired)).toBe(true);
    expect(f.load.workspace(f.catalog.workspace("workspace")!).state).toBe("stale");
    noProcesses();
  }, 20000);

  it("decides a definite local executable change without consulting the compatibility evidence", async () => {
    const { f } = await activated();
    writeFileSync(f.executable, "#!/bin/sh\nexit 1\n");
    chmodSync(f.executable, 0o700);
    const verdict = f.load.provider(f.catalog.provider("provider")!);
    expect(verdict).toMatchObject({ state: "invalid", ready: false, reasonCodes: ["PROVIDER_EXECUTABLE_CHANGED"] });
    expect(activationWithdrawalRequired(verdict)).toBe(true);
    noProcesses();
  }, 20000);

  it("distinguishes configuration, policy and policy-capability changes", async () => {
    const configured = await activated();
    configured.f.store.db.prepare("UPDATE provider_instances SET config_json=? WHERE id='provider'")
      .run(JSON.stringify({ model: "changed-model", environment: {}, sandboxRequired: true }));
    expect(configured.f.load.provider(configured.f.catalog.provider("provider")!).reasonCodes).toEqual(["PROVIDER_CONFIG_CHANGED"]);

    const policy = await activated();
    policy.f.store.db.prepare("UPDATE provider_instances SET policy_version=2 WHERE id='provider'").run();
    // `policyVersion` is part of the configuration fingerprint (the existing
    // recovery-fingerprint idiom), so a policy bump reports both precise codes.
    expect(policy.f.load.provider(policy.f.catalog.provider("provider")!).reasonCodes).toContain("PROVIDER_POLICY_CHANGED");

    const capabilities = await activated();
    capabilities.f.store.db.prepare("UPDATE provider_instances SET policy_capabilities_json=? WHERE id='provider'").run(JSON.stringify(["streamingText"]));
    // Policy capabilities feed both the policy fingerprint and the advertised
    // capability list, so the verdict reports both precise codes.
    expect(capabilities.f.load.provider(capabilities.f.catalog.provider("provider")!).reasonCodes).toContain("PROVIDER_RUNTIME_CHANGED");
    noProcesses();
  }, 20000);

  it("invalidates on checkout identity replacement and on workspace policy change", async () => {
    const identity = await activated();
    rmSync(identity.f.checkout, { recursive: true, force: true });
    mkdirSync(identity.f.checkout);
    const verdict = identity.f.load.workspace(identity.f.catalog.workspace("workspace")!);
    expect(verdict).toMatchObject({ state: "invalid", ready: false, reasonCodes: ["WORKSPACE_IDENTITY_CHANGED"] });

    const policy = await activated();
    policy.f.store.db.prepare("UPDATE workspaces SET repository_id='repository-2' WHERE id='workspace'").run();
    expect(policy.f.load.workspace(policy.f.catalog.workspace("workspace")!).reasonCodes).toEqual(["WORKSPACE_POLICY_CHANGED"]);
    noProcesses();
  }, 20000);

  it("stays uncheckable for every observation refusal and never infers readiness", async () => {
    const missingSupervision = await activated();
    const withoutSupervision = new HostActivationLoad(missingSupervision.f.operations,
      missingSupervision.f.observation({ supervision: () => undefined, runtime: missingSupervision.f.runtime, evidencePath: missingSupervision.f.evidencePath }));
    const verdict = withoutSupervision.provider(missingSupervision.f.catalog.provider("provider")!);
    expect(verdict).toMatchObject({ state: "uncheckable", ready: false, reasonCodes: ["SUPERVISION_CONTRACT_UNAVAILABLE"] });
    expect(activationWithdrawalRequired(verdict)).toBe(true);

    const missingEvidence = await activated();
    rmSync(missingEvidence.f.evidencePath);
    expect(missingEvidence.f.load.provider(missingEvidence.f.catalog.provider("provider")!))
      .toMatchObject({ state: "uncheckable", reasonCodes: ["PROVIDER_COMPATIBILITY_EVIDENCE_MISSING"] });

    const missingRuntime = await activated();
    const withoutRuntime = new HostActivationLoad(missingRuntime.f.operations,
      missingRuntime.f.observation({ supervision: missingRuntime.f.supervision, runtime: () => undefined, evidencePath: missingRuntime.f.evidencePath }));
    expect(withoutRuntime.provider(missingRuntime.f.catalog.provider("provider")!))
      .toMatchObject({ state: "uncheckable", reasonCodes: ["PROVIDER_RUNTIME_UNAVAILABLE"] });
    noProcesses();
  }, 20000);

  it("keeps disabled resources out of withdrawal and tampered payloads invalid", async () => {
    const disabled = await activated();
    disabled.f.store.db.prepare("UPDATE provider_instances SET state='disabled' WHERE id='provider'").run();
    const missing = disabled.f.load.provider(disabled.f.catalog.provider("provider")!);
    expect(missing).toMatchObject({ state: "missing", ready: false, reasonCodes: [] });
    expect(activationWithdrawalRequired(missing)).toBe(false);

    const tampered = await activated();
    const referenced = tampered.f.operations.referencedOperation("workspace", "workspace")!;
    tampered.f.store.db.prepare("UPDATE host_execution_operations SET evidence_json=? WHERE id=?").run(JSON.stringify({
      id: referenced.id, digest: referenced.evidence!.digest, validUntil: ACTIVATION_FIXTURE_VALID_UNTIL,
      workspaceId: "workspace", providerInstanceId: "provider", payload: { v: 1, kind: "activation" },
    }), referenced.id);
    expect(tampered.f.load.workspace(tampered.f.catalog.workspace("workspace")!))
      .toMatchObject({ state: "invalid", reasonCodes: ["ACTIVATION_EVIDENCE_INVALID"] });
    noProcesses();
  }, 20000);

  it("stays fail-closed and read-only without the activation schema", () => {
    const f = createActivationFixture();
    const withdrawals: string[] = [];
    const store: ActivationLoadStore = {
      available: false,
      recordReadiness: () => 0,
      recordDigests: () => ({ readinessRevision: 0 }),
      referencedOperation: () => undefined,
      withdrawReadiness: (kind, id) => { withdrawals.push(`${kind}:${id}`); },
    };
    const load = new HostActivationLoad(store, f.observation({ supervision: f.supervision, runtime: f.runtime, evidencePath: f.evidencePath }));
    expect(load.available).toBe(false);
    expect(load.workspace(f.catalog.workspace("workspace")!)).toMatchObject({ state: "uncheckable", reasonCodes: ["ACTIVATION_SCHEMA_UNAVAILABLE"] });
    expect(load.provider(f.catalog.provider("provider")!)).toMatchObject({ state: "uncheckable", reasonCodes: ["ACTIVATION_SCHEMA_UNAVAILABLE"] });
    // A pre-011 Store cannot persist a verdict and reading history never writes.
    expect(load.invalidateDecided(f.readinessScan())).toEqual([]);
    const port = activationReadinessPort(load, f.readinessScan);
    for (const readiness of port.scan()) port.withdraw(readiness, ACTIVATION_FIXTURE_NOW);
    expect(withdrawals).toEqual([]);
    noProcesses();
  }, 20000);
});

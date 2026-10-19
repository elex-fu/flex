import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_CLI_USAGE, isActivationCliCommand, runActivationCli,
  type ActivationCliResult,
} from "./activation-cli.js";
import {
  ACTIVATION_FIXTURE_ACTOR, ACTIVATION_FIXTURE_VALID_UNTIL, createActivationFixture, disposeActivationFixtures,
} from "../test-support/activation-fixture.js";

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

/** Narrow one CLI union member so the command-specific fields are reachable. */
function expectCommand<C extends ActivationCliResult["command"]>(result: ActivationCliResult, command: C): Extract<ActivationCliResult, { command: C }> {
  expect(result.command).toBe(command);
  return result as Extract<ActivationCliResult, { command: C }>;
}

describe("activation CLI", () => {
  it("runs verify, activate and inspect with retry-safe explicit command IDs", async () => {
    const f = createActivationFixture();
    f.writePassedEvidence();
    const service = f.service();
    const verifyArgv = ["verify", "--workspace", "workspace", "--provider", "provider", "--command-id", "cli-verify"];
    const verified = expectCommand(await runActivationCli(verifyArgv, service), "verify");
    expect(verified).toMatchObject({ evidenceId: verified.operationId, validUntil: ACTIVATION_FIXTURE_VALID_UNTIL });
    expect(verified.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    // A lost response is retried with the original command ID and returns the stored receipt.
    expect(await runActivationCli(verifyArgv, service)).toEqual(verified);
    expect(f.operations.operationForCommand(ACTIVATION_FIXTURE_ACTOR, "cli-verify")).toMatchObject({ state: "ready" });

    const activated = expectCommand(await runActivationCli(["activate", "--evidence", verified.evidenceId, "--command-id", "cli-activate"], service), "activate");
    expect(activated).toMatchObject({ reused: false });
    expect(activated.activations.map((target) => target.kind)).toEqual(["workspace", "provider"]);
    expect(f.catalog.workspace("workspace")?.state).toBe("active");

    const inspect = expectCommand(await runActivationCli(["inspect", verified.evidenceId], service), "inspect");
    expect(inspect.operation).toMatchObject({ id: verified.evidenceId, state: "completed" });
    // Exactly the two controlled managed query shapes; no process was created.
    expect(f.queries).toHaveLength(2);
    noProcesses();
  }, 20000);

  it("defaults a fresh verify command ID and never silently reuses one", async () => {
    const f = createActivationFixture();
    f.writePassedEvidence();
    const service = f.service();
    const generated = expectCommand(await runActivationCli(["verify", "--workspace", "workspace", "--provider", "provider"], service, { commandId: () => "cli-generated" }), "verify");
    expect(f.operations.operationForCommand(ACTIVATION_FIXTURE_ACTOR, "cli-generated")?.id).toBe(generated.operationId);
    const random = expectCommand(await runActivationCli(["verify", "--workspace", "workspace", "--provider", "provider"], service), "verify");
    const operation = service.inspect(random.operationId)!;
    expect(operation.commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(operation.commandId).not.toBe("cli-generated");
    expect(f.operations.operationForCommand(ACTIVATION_FIXTURE_ACTOR, operation.commandId)?.id).toBe(random.operationId);
    noProcesses();
  }, 20000);

  it("answers usage errors for unknown, duplicate, missing and misplaced arguments", async () => {
    const f = createActivationFixture();
    const service = f.service();
    const failures: Array<readonly string[]> = [
      [],
      ["unknown"],
      ["verify", "--workspace", "workspace"],
      ["verify", "--provider", "provider"],
      ["verify", "--workspace", "workspace", "--provider"],
      ["verify", "--workspace", "workspace", "--workspace", "workspace", "--provider", "provider"],
      ["verify", "--workspace", "workspace", "--provider", "provider", "--unexpected", "value"],
      ["activate", "--evidence", "evidence"],
      ["activate", "--command-id", "command"],
      ["inspect", "--evidence", "evidence"],
      ["inspect", "one", "two"],
    ];
    for (const argv of failures) {
      await expect(runActivationCli(argv, service)).rejects.toMatchObject({ code: "ACTIVATION_CLI_USAGE", message: ACTIVATION_CLI_USAGE });
    }
    expect(isActivationCliCommand("verify")).toBe(true);
    expect(isActivationCliCommand("inspect")).toBe(true);
    expect(isActivationCliCommand("activate")).toBe(true);
    expect(isActivationCliCommand("other")).toBe(false);
    expect(isActivationCliCommand(undefined)).toBe(false);
    noProcesses();
  }, 20000);

  it("refuses inspect for an unknown operation and never writes from inspect", async () => {
    const f = createActivationFixture();
    const service = f.service();
    expect(service.inspect("missing-operation")).toBeUndefined();
    await expect(runActivationCli(["inspect", "missing-operation"], service)).rejects.toMatchObject({ code: "ACTIVATION_OPERATION_NOT_FOUND" });
    expect(f.operations.latestForResource("activation", { workspaceId: "workspace", providerInstanceId: "provider" })).toBeUndefined();
    noProcesses();
  }, 20000);
});

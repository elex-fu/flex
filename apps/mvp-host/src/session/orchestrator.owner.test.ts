import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterStatus, ProviderAdapter, TurnOutcome } from "../provider/types.js";
import { SessionOrchestrator } from "./orchestrator.js";

const roots: string[] = [];
const hosts: SessionOrchestrator[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class HoldingAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly preflight = vi.fn(async () => this.status());
  calls = 0;
  private completeRun: ((outcome: TurnOutcome) => void) | undefined;
  constructor(readonly workspace: string) {}
  async status(): Promise<AdapterStatus> {
    return { provider: this.provider, transport: "deterministic", adapterVersion: "test", executable: "test", runtimeVersion: "test", workspace: this.workspace, sandboxRequired: true };
  }
  async runTurn(): Promise<TurnOutcome> {
    this.calls += 1;
    return new Promise<TurnOutcome>((resolve) => { this.completeRun = resolve; });
  }
  async interrupt(): Promise<"unavailable"> { return "unavailable"; }
  respondApproval(): boolean { return false; }
  complete(): void { this.completeRun?.({ status: "completed", providerSessionId: "test-native", evidence: { kind: "native-terminal", sourceId: "test-native-terminal" } }); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flyx-owner-orchestrator-"));
  roots.push(root);
  const workspace = join(root, "checkout");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "test workspace\n");
  execFileSync("git", ["init", "--quiet", workspace]);
  symlinkSync(workspace, join(root, "checkout-alias"));
  const coordinationDirectory = join(root, "coordination");
  const make = (name: string, adapter: HoldingAdapter, configuredWorkspace = workspace) => {
    const host = new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace: configuredWorkspace, databasePath: join(root, name, "host.sqlite"), adapter, coordinationDirectory });
    for (const id of ["device", "first", "second"]) host.store.createDevice({ id, hostId: "test-host", platform: "test", credentialKind: "browser-session", scopes: ["session:write", "approval:write"], credentialRevision: 0, createdAt: new Date().toISOString() });
    hosts.push(host);
    return host;
  };
  return { root, workspace, coordinationDirectory, make };
}

async function complete(host: SessionOrchestrator, adapter: HoldingAdapter): Promise<void> {
  await host.worker.drainDispatch();
  const terminal = new Promise<void>((resolve) => {
    const unsubscribe = host.subscribe((event) => { if (event.type === "turn.reconciled") { unsubscribe(); resolve(); } });
  });
  adapter.complete();
  await terminal;
  expect(await host.worker.drainOperations()).toBe(true);
}

describe("ownership at the actual Orchestrator entry point", () => {
  it("blocks a second Host before it can recover or mutate an active Turn (B01)", async () => {
    const f = fixture();
    const adapter = new HoldingAdapter(f.workspace);
    const host = f.make("data", adapter);
    const response = await host.startTurn("device", "command", "keep running");
    const original = host.store.getTurn(response.turnId);
    const facts = host.store.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const second = new HoldingAdapter(f.workspace);
    expect(() => f.make("data", second)).toThrow("Another Host");
    expect(host.store.getTurn(response.turnId)).toEqual(original);
    expect(host.store.getCommandReceipt("device", "command")?.state).toBe("accepted");
    expect(host.store.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(facts);
    expect(second.calls).toBe(0);
    expect(second.preflight).not.toHaveBeenCalled();
    await complete(host, adapter);
    expect(host.workspaceLease).toBeUndefined();
  });

  it("blocks cross-DB checkout writers before baseline or command acceptance", async () => {
    const f = fixture();
    const firstAdapter = new HoldingAdapter(f.workspace);
    const secondAdapter = new HoldingAdapter(f.workspace);
    const first = f.make("data-one", firstAdapter);
    const second = f.make("data-two", secondAdapter, join(f.root, "checkout-alias"));
    await first.startTurn("first", "command-one", "first write");
    await expect(second.startTurn("second", "command-two", "conflicting write")).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(secondAdapter.calls).toBe(0);
    expect(second.store.getSessionBaseline(second.sessionId)).toBeUndefined();
    expect(second.store.getCommandReceipt("second", "command-two")).toBeUndefined();
    await complete(first, firstAdapter);
    await expect(second.startTurn("second", "command-two", "conflicting write")).resolves.toMatchObject({ status: "accepted" });
    await complete(second, secondAdapter);
  });

  it("rejects private data inside or surrounding the configured checkout before creating its database", () => {
    const f = fixture();
    const databasePath = join(f.workspace, "private", "host.sqlite");
    expect(() => new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace: f.workspace, databasePath, adapter: new HoldingAdapter(f.workspace), coordinationDirectory: f.coordinationDirectory })).toThrow("overlaps");
    expect(existsSync(databasePath)).toBe(false);
    expect(() => new SessionOrchestrator({ canReleaseWorkspace: () => true, workspace: f.workspace, databasePath: join(f.root, "host.sqlite"), adapter: new HoldingAdapter(f.workspace), coordinationDirectory: f.coordinationDirectory })).toThrow("overlaps");
    expect(existsSync(join(f.root, "host.sqlite"))).toBe(false);
  });
});

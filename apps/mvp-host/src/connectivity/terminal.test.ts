import { afterEach, describe, expect, it, vi } from "vitest";
import { createPairingConfirmation, parseHostCommand } from "./terminal.js";

afterEach(() => vi.useRealTimers());

describe("terminal pairing approval", () => {
  it("denies noninteractive requests unless explicitly opted out", async () => {
    const ask = vi.fn();
    expect(await createPairingConfirmation({ interactive: false, requireConfirmation: true, ask })()).toBe(false);
    expect(await createPairingConfirmation({ interactive: false, requireConfirmation: false, ask })()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("serializes concurrent phone prompts and expires queued requests", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(() => new Promise<string>(() => {}));
    const confirm = createPairingConfirmation({ interactive: true, requireConfirmation: true, ask, timeoutMs: 100 });
    const first = confirm();
    const second = confirm();
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the prompt after an answer and cancels on shutdown", async () => {
    const answers: Array<(answer: string) => void> = [];
    const ask = vi.fn(() => new Promise<string>((resolve) => answers.push(resolve)));
    const confirm = createPairingConfirmation({ interactive: true, requireConfirmation: true, ask });
    const first = confirm();
    const second = confirm();
    await Promise.resolve();
    answers[0]!("yes");
    expect(await first).toBe(true);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(2);
    confirm.close();
    expect(await second).toBe(false);
    expect(await confirm()).toBe(false);
  });

  it("identifies a proposed relay device without printing terminal control characters", async () => {
    const ask = vi.fn<(prompt: string, signal: AbortSignal) => Promise<string>>(async () => "n");
    const confirm = createPairingConfirmation({ interactive: true, requireConfirmation: true, ask });
    expect(await confirm({ displayName: "Phone\u001b[31m\nspoof", proposedDevicePublicKey: "public-key" })).toBe(false);
    expect(ask.mock.calls[0]?.[0]).toContain("device key");
    expect(ask.mock.calls[0]?.[0]).not.toContain("\u001b");
    expect(ask.mock.calls[0]?.[0]).not.toContain("\n");
  });
});

describe("Host CLI commands", () => {
  it("routes exact operations and coordinated Catalog import commands without startup", () => {
    expect(parseHostCommand(["doctor"])).toEqual({kind:"operations",action:"doctor"});
    expect(parseHostCommand(["backup","backup-dir"])).toEqual({kind:"operations",action:"backup",directory:"backup-dir"});
    expect(parseHostCommand(["validate","backup-dir"])).toEqual({kind:"operations",action:"validate",directory:"backup-dir"});
    expect(parseHostCommand(["restore","backup-dir","rollback-dir"])).toEqual({kind:"operations",action:"restore",directory:"backup-dir",rollbackDirectory:"rollback-dir"});
    expect(parseHostCommand(["catalog","dry-run","source.sqlite","backup-dir"])).toEqual({kind:"catalog-import",backupDirectory:"backup-dir",request:{mode:"dry-run",sourceDatabasePath:"source.sqlite"}});
    expect(parseHostCommand(["catalog","import","source.sqlite","backup-dir","a".repeat(64)])).toEqual({kind:"catalog-import",backupDirectory:"backup-dir",request:{mode:"import",sourceDatabasePath:"source.sqlite",approvedSourceDigest:"a".repeat(64)}});
    expect(parseHostCommand(["activation","verify","--workspace","w","--provider","p"]))
      .toEqual({kind:"activation",command:"verify",argv:["verify","--workspace","w","--provider","p"]});
    expect(parseHostCommand(["activation","inspect","operation-1"])).toEqual({kind:"activation",command:"inspect",argv:["inspect","operation-1"]});
    expect(parseHostCommand(["activation","activate","--evidence","operation-1","--command-id","command-1"]))
      .toEqual({kind:"activation",command:"activate",argv:["activate","--evidence","operation-1","--command-id","command-1"]});
    for(const args of [["doctor","extra"],["backup"],["restore","backup-dir"],["catalog","import","source.sqlite","backup-dir"],
      ["activation"],["activation","status"],["activation","verify","--workspace"]])expect(()=>parseHostCommand(args)).toThrow();
  });
  it("keeps startup as default and supports device and identity management", () => {
    expect(parseHostCommand([])).toEqual({ kind: "start" });
    expect(parseHostCommand(["devices", "revoke", "device-123"])).toEqual({ kind: "devices-revoke", deviceId: "device-123" });
    expect(parseHostCommand(["identity", "rotate"])).toEqual({ kind: "identity-rotate" });
    expect(parseHostCommand(["devices", "list"])).toEqual({ kind: "devices-list" });
    expect(() => parseHostCommand(["devices", "revoke", "all", "extra"])).toThrow("Usage");
    expect(() => parseHostCommand(["devices", "revoke", "../elsewhere"])).toThrow("Usage");
  });
});

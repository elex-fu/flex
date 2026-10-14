import { describe, expect, it } from "vitest";
import { ProviderIngestion } from "./provider-ingestion.js";
import { dispatchContextForTurn, fenceAdapterEvent } from "../provider/types.js";
import type { AdapterEvent } from "../provider/types.js";

function barrier() { let release!: () => void; const promise = new Promise<void>((yes) => { release = yes; }); return { promise, release }; }
const context = dispatchContextForTurn("turn", { hostOwnerId: "owner", hostOwnerGeneration: 1, sessionId: "session", flyxTurnId: "turn", runtimeId: "runtime", runtimeGeneration: 1, attemptId: "attempt" });

describe("Provider ingestion drain", () => {
  it("drains queued terminal ingestion after a producer stops and seals later callbacks", async () => {
    const held = barrier(); const seen: string[] = []; let tracked = 0;
    const ingress = new ProviderIngestion({ admit: () => true, handle: async (event) => { if (event.kind === "assistant_delta") await held.promise; seen.push(event.kind); }, failed: () => { throw new Error("unexpected ingestion failure"); },
      track: async (run) => { tracked++; try { return await run(); } finally { tracked--; } } });
    ingress.enqueue(fenceAdapterEvent(context, { kind: "assistant_delta", itemId: "item", text: "prefix" }));
    ingress.enqueue(fenceAdapterEvent(context, { kind: "turn_completed", result: "done", costUsd: 0, numTurns: 1 }));
    let drained = false; const drain = ingress.drain().then(() => { drained = true; }); await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false); expect(tracked).toBe(1); held.release(); await drain;
    expect(seen).toEqual(["assistant_delta", "turn_completed"]); expect(tracked).toBe(0);
    ingress.seal(); await ingress.enqueue(fenceAdapterEvent(context, { kind: "assistant_delta", itemId: "item", text: "late" })); expect(seen).toHaveLength(2);
  });
  it("does not publish synthetic possible-send failures as Turn terminal facts", async () => {
    const seen: AdapterEvent[] = []; const ingress = new ProviderIngestion({ admit: () => true, handle: (event) => { seen.push(event); }, failed: () => {} });
    ingress.enqueue(fenceAdapterEvent(context, { kind: "turn_failed", subtype: "turn_start_failed", errors: ["socket ended"] }));
    ingress.enqueue(fenceAdapterEvent(context, { kind: "turn_failed", subtype: "client_start_failed", errors: ["no child"] }));
    await ingress.drain(); expect(seen[0]).toMatchObject({ kind: "diagnostic", code: "PROVIDER_TERMINAL_UNPROVEN" }); expect(seen[1]).toMatchObject({ kind: "turn_failed", terminalEvidence: { kind: "not-dispatched" } });
  });
  it("includes the one overflow failure operation in drain and bounds subsequent ingress", async () => {
    const held = barrier(); const failureHeld = barrier(); let failures = 0;
    const ingress = new ProviderIngestion({ maxQueued: 1, admit: () => true, handle: async () => held.promise, failed: async () => { failures++; await failureHeld.promise; } });
    const event = fenceAdapterEvent(context, { kind: "assistant_delta", itemId: "item", text: "prefix" });
    ingress.enqueue(event); ingress.enqueue(event); ingress.enqueue(event);
    let drained = false; const drain = ingress.drain().then(() => { drained = true; }); held.release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(drained).toBe(false); failureHeld.release(); await drain; expect(failures).toBe(1);
  });
});

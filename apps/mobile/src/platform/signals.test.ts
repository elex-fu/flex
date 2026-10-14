import { describe, expect, it } from "vitest";
import { NativePlatformSignals } from "./signals";
import type { NetworkState } from "./signals";
describe("native lifecycle signals", () => {
  it("publishes AppState/NetInfo facts only and ignores a stale initial reachability read", async () => {
    let appChange!: (state: string) => void, netChange!: (state: NetworkState) => void, resolve!: (state: NetworkState) => void;
    let removed = 0; const initial = new Promise<NetworkState>((yes) => { resolve = yes; });
    const signals = new NativePlatformSignals({ currentState: "active", addEventListener: (_event, handler) => { appChange = handler; return { remove: () => { removed++; } }; } }, { fetch: () => initial, addEventListener: (handler) => { netChange = handler; return () => { removed++; }; } });
    const events: string[] = []; const off = signals.subscribe((event) => events.push(event.type));
    expect(signals.getState().online).toBe(false);
    netChange({ isConnected: false, isInternetReachable: false }); resolve({ isConnected: true, isInternetReachable: true }); await initial; await Promise.resolve(); expect(signals.getState().online).toBe(false);
    netChange({ isConnected: true, isInternetReachable: true }); appChange("background"); appChange("active"); expect(events).toEqual(["online", "visibility", "visibility"]);
    off(); off(); expect(removed).toBe(2);
  });
});

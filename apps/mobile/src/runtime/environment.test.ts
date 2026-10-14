import { describe, expect, it, vi } from "vitest";
import { MemoryClientStore } from "@flyx/client-core";
import type { NativeClientStore } from "../platform/store";
import * as Linking from "expo-linking";
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-linking", () => ({ addEventListener: vi.fn(), getInitialURL: vi.fn(async () => null) }));
vi.mock("expo-notifications", () => ({ addNotificationResponseReceivedListener: vi.fn(), getLastNotificationResponseAsync: vi.fn(async () => null), clearLastNotificationResponseAsync: vi.fn(async () => {}), AndroidImportance: { DEFAULT: 3 } }));
vi.mock("../platform/expo", () => ({ expoPlatformSignals: { getState: () => ({ online: false, visibility: "visible" }), subscribe: () => () => {} }, nativeFetch: vi.fn(), expoFetchImplementation: vi.fn(), nativeSocketFactory: vi.fn(), openExpoStore: vi.fn() }));
import { MobileEnvironment } from "./environment";
describe("native app-owned Host lifecycle", () => {
  it("releases React observers without stopping and clears a forgotten owner before its profile loads", async () => {
    const store = new MemoryClientStore(); await store.putProfile({ hostId: "host-a", label: "A", hostPublicKey: "pin", signingPublicKey: "sign", fingerprint: "pin", endpoints: [] });
    const app = new MobileEnvironment(store as unknown as NativeClientStore), runtime = app.registry.get("host-a"); vi.spyOn(runtime, "start").mockResolvedValue(); const stop = vi.spyOn(runtime, "stop");
    const observed: unknown[] = [], off = app.observe((client) => observed.push(client)); await app.selectHost("host-a"); expect(runtime.getState().profile).toBeUndefined(); off(); expect(stop).not.toHaveBeenCalled(); expect(app.registry.get("host-a")).toBe(runtime);
    await app.forget("host-a"); expect(app.current).toBeUndefined(); expect(app.registry.peek("host-a")).toBeUndefined(); expect(await store.getProfile("host-a")).toBeUndefined(); expect(await store.getSelectedHost()).toBeUndefined(); expect(observed).toEqual([undefined, runtime]);
  });
  it("installs platform routes only once independently of React mounts", () => {
    const app = new MobileEnvironment(new MemoryClientStore() as unknown as NativeClientStore); app.installPlatformRoutes(); app.installPlatformRoutes(); expect(Linking.addEventListener).toHaveBeenCalledTimes(1); expect(Linking.getInitialURL).toHaveBeenCalledTimes(1);
  });
});

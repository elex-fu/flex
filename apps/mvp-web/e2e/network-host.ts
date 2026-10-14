import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostDescriptorV1 } from "@flyx/mvp-protocol";

/** Chromium trust injection for the fixture's public, deterministic leaf key. */
export const NETWORK_FIXTURE_CHROMIUM_ARGS = ["--ignore-certificate-errors-spki-list=V9Ocn+KJql9h1P6R3PlwOd0mjJubr50BKEvQWygHXw8="] as const;

export type NetworkFixture = {
  pid: number;
  appUrl: string;
  hostUrl: string;
  relayUrl: string;
  hostId: string;
  fingerprint: string;
  offers: string[];
  descriptor: HostDescriptorV1;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Real TLS/WSS fixture, with the same protocol, gateway, provider and relay as production. */
export async function startNetworkHost(): Promise<{
  fixture: NetworkFixture;
  setDirectAvailable(available: boolean): Promise<void>;
  dropRelayConnections(): Promise<void>;
  revokeDevice(deviceId: string): Promise<boolean>;
  stop(): Promise<void>;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(repoRoot, "apps/mvp-host/src/test-support/network-e2e-main.ts")], {
    cwd: repoRoot,
    env: { ...process.env, FLYX_WEB_ROOT: resolve(repoRoot, "apps/mvp-web/dist") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const fixture = await readReady(child).catch((error) => { child.kill("SIGTERM"); throw error; });
  return {
    fixture,
    setDirectAvailable: (available) => control(child, { action: "direct.available", available }),
    dropRelayConnections: () => control(child, { action: "relay.drop" }),
    revokeDevice: (deviceId) => control<boolean>(child, { action: "device.revoke", deviceId }),
    stop: async () => {
      try { process.kill(fixture.pid, "SIGTERM"); } catch { /* already exited */ }
      await new Promise<void>((resolvePromise) => {
        if (child.exitCode !== null) { resolvePromise(); return; }
        const timer = setTimeout(() => {
          try { process.kill(fixture.pid, "SIGKILL"); } catch { /* already exited */ }
          child.kill("SIGKILL");
          resolvePromise();
        }, 10_000);
        child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
      });
    },
  };
}

let nextControlId = 1;
function control<T = void>(child: ChildProcess, command: Record<string, unknown>): Promise<T> {
  if (!child.connected) return Promise.reject(new Error("Network fixture control channel is closed"));
  const id = nextControlId++;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error("Network fixture control timed out")); }, 5_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id) return;
      cleanup();
      if ("ok" in message && message.ok === true) resolvePromise(("value" in message ? message.value : undefined) as T);
      else rejectPromise(new Error("Network fixture rejected control command"));
    };
    const onExit = () => { cleanup(); rejectPromise(new Error("Network fixture exited during control command")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage); child.once("exit", onExit);
    child.send?.({ id, ...command }, (error) => { if (error) { cleanup(); rejectPromise(error); } });
  });
}

function readReady(child: ChildProcess): Promise<NetworkFixture> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const timer = setTimeout(() => rejectPromise(new Error("Network fixture did not become ready within 45s")), 45_000);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("exit", (code) => { clearTimeout(timer); rejectPromise(new Error(`Network fixture exited before readiness (${code})`)); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { process.stderr.write(`[network-fixture] ${chunk}`); });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const match = /^FLYX_NETWORK_E2E_READY (.+)$/m.exec(buffered);
      if (!match) { if (buffered.length > 128_000) buffered = buffered.slice(-64_000); return; }
      clearTimeout(timer);
      try {
        const fixture = JSON.parse(match[1]!) as NetworkFixture;
        if (!fixture.pid || !fixture.appUrl || !fixture.hostUrl || fixture.offers.length < 2 || !fixture.descriptor?.signature) throw new Error("Invalid network fixture marker");
        // The readiness line contains one-time offers. Never echo it into
        // logs or include it in an assertion/error message.
        buffered = "";
        resolvePromise(fixture);
      } catch { rejectPromise(new Error("Network fixture returned an invalid readiness marker")); }
    });
  });
}

import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "@flyx/mvp-protocol";
import QRCode from "qrcode";
import { DeviceRegistry } from "./auth/device-registry.js";
import { parseConnectivityConfig, resolveConnectivityConfig } from "./connectivity/config.js";
import { createPairingConfirmation, parseHostCommand, type HostCommand } from "./connectivity/terminal.js";
import { getHostIdentityMirror, loadOrCreateHostIdentity, publicHostIdentity, rotateHostIdentity, type HostIdentityFileV1 } from "./identity/host-identity.js";
import { createHostServer } from "./server.js";
import { SessionOrchestrator } from "./session/orchestrator.js";
import { SqliteStore } from "./storage/db.js";

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Host startup failed");
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = parseHostCommand(process.argv.slice(2));
  if (command.kind === "help") {
    console.log("Flyx Host: start | devices list | devices revoke <deviceId> | devices revoke-all | identity show | identity rotate");
    console.log("Select the existing Host using FLYX_DB and FLYX_IDENTITY_DIR. Key rotation requires confirmation in a local terminal.");
    return;
  }
  const workspace = resolve(process.env.FLYX_WORKSPACE ?? resolve(process.cwd(), "packages/claude-fixtures"));
  const provider = parseProvider(process.env.FLYX_PROVIDER);
  const defaultDatabase = provider === "codex" ? ".flyx/mvp-codex.sqlite" : ".flyx/mvp.sqlite";
  const databasePath = resolve(process.env.FLYX_DB ?? resolve(process.cwd(), defaultDatabase));
  const identityDirectory = resolve(process.env.FLYX_IDENTITY_DIR ?? join(dirname(databasePath), "identity"));
  const connectivity = command.kind === "start" ? await resolveConnectivityConfig(parseConnectivityConfig()) : undefined;
  await mkdir(dirname(databasePath), { recursive: true });
  // Management commands inspect the store without constructing an orchestrator:
  // opening a provider session would otherwise recover another Host's turns.
  const bootstrapStore = new SqliteStore(databasePath);
  let identity: HostIdentityFileV1;
  try {
    identity = await loadOrCreateHostIdentity({ directory: identityDirectory, expectedMirror: bootstrapStore.getHostIdentityMirror() ?? null });
    bootstrapStore.setHostIdentityMirror(getHostIdentityMirror(identity));
    if (command.kind !== "start") {
      await manageHost(command, bootstrapStore, identity, identityDirectory);
      return;
    }
  } finally {
    bootstrapStore.close();
  }
  await assertFixtureWorkspace(workspace);
  const orchestrator = new SessionOrchestrator({ workspace, databasePath, provider });
  const pairingConfirmation = createPairingConfirmation();
  let server: ReturnType<typeof createHostServer> | undefined;
  try {
    if (process.env.FLYX_SKIP_PREFLIGHT !== "1") {
      const status = await orchestrator.adapter.preflight();
      console.log(`${providerName(status.provider)} preflight passed: ${status.transport} ${status.adapterVersion}, runtime ${status.runtimeVersion}`);
    }
    server = createHostServer({ orchestrator, pairingConfirmation, identity, connectivity: connectivity!,
      ...(process.env.FLYX_WEB_ROOT ? { webRoot: process.env.FLYX_WEB_ROOT } : {}) });
    const address = await server.start();
    console.log(`Flyx MVP Host listening at ${address}`);
    console.log(`Workspace: ${workspace}`);
    console.log(`Provider: ${providerName(provider)}`);
    console.log(`Host: ${identity.hostId} (${identity.fingerprint})`);
    console.log(`Connectivity: ${connectivity!.mode}${connectivity!.publicBaseUrl ? ` — ${connectivity!.publicBaseUrl}` : ""}`);
    let shuttingDown = false;
    const runningServer = server;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      pairingConfirmation.close();
      try { await runningServer.stop(); }
      finally { process.exit(0); }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    if (process.stdout.isTTY) {
      if (connectivity!.publicBaseUrl || connectivity!.allowInsecureHttp) {
        await printPairingUrl("Direct pairing", server.getPairingUrl());
      } else {
        console.log("For phone pairing, configure Tailscale Serve and restart with FLYX_CONNECTIVITY_MODE=tailscale.");
      }
      const relayPairingUrl = server.getRelayPairingUrl(connectivity!.hostedAppUrl);
      if (relayPairingUrl) await printPairingUrl("Relay pairing", relayPairingUrl);
    } else {
      console.log("Pairing links are shown only in a local terminal. Interactive pairing confirmation is required by default.");
    }
  } catch (error) {
    pairingConfirmation.close();
    if (server) await server.stop(); else orchestrator.close();
    throw error;
  }
}

async function manageHost(command: HostCommand, store: SqliteStore, identity: HostIdentityFileV1, directory: string): Promise<void> {
  const devices = new DeviceRegistry(store, identity.hostId, { recoverLeases: false });
  try {
    if (command.kind === "devices-list") {
      console.log(JSON.stringify(devices.listDevices(), null, 2));
    } else if (command.kind === "devices-revoke") {
      const revoked = devices.revokeFromLocal(command.deviceId);
      if (!revoked) throw new Error("Device does not exist or is already revoked on this Host");
      console.log(`Revoked device ${command.deviceId}; its active connections will close.`);
    } else if (command.kind === "devices-revoke-all") {
      console.log(`Revoked ${devices.revokeAllFromLocal()} devices and invalidated active pairing grants.`);
    } else if (command.kind === "identity-show") {
      console.log(JSON.stringify(publicHostIdentity(identity), null, 2));
    } else if (command.kind === "identity-rotate") {
      const confirm = createPairingConfirmation({ requireConfirmation: true,
        prompt: "Rotate this Host's keys and revoke all devices? Type rotate to confirm: ", accept: (answer) => answer.trim() === "rotate" });
      let approved: boolean;
      try { approved = await confirm(); } finally { confirm.close(); }
      if (!approved) throw new Error("Key rotation was not confirmed in a local terminal");
      const rotated = await rotateHostIdentity({ directory, expectedMirror: getHostIdentityMirror(identity), authorization: { kind: "local" },
        beforeCommit: (next, previous) => store.db.transaction(() => {
          devices.revokeAllFromLocal();
          store.rotateHostIdentityMirror(next, previous);
        })(),
      });
      console.log(`Host key rotated: ${rotated.fingerprint}. Restart the Host and pair each device again.`);
    }
  } finally {
    devices.dispose();
  }
}

async function printPairingUrl(label: string, url: string): Promise<void> {
  console.log(`${label} URL (single use, expires in 5 minutes): ${url}`);
  // QR generation stays on this machine; the fragment contains the one-use
  // grant and public identity only, and is never sent to a QR service.
  console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
}

async function assertFixtureWorkspace(root: string): Promise<void> {
  try {
    const marker = await stat(resolve(root, ".git"));
    if (!marker.isDirectory() && !marker.isFile()) throw new Error("not a Git repository");
  } catch (error) {
    throw new Error(`FLYX_WORKSPACE must be an existing Git fixture repository: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseProvider(value: string | undefined): ProviderId {
  if (value === undefined || value === "" || value === "claude") return "claude";
  if (value === "codex") return "codex";
  throw new Error(`FLYX_PROVIDER must be \"claude\" or \"codex\", received: ${value}`);
}

function providerName(value: ProviderId): string {
  return value === "codex" ? "Codex" : "Claude";
}
